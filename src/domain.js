// 读取并检查项目共享的领域资料。
//
// 除基础结构外，校验以下领域规则：
// - 档案按「企业 × 目标国家」唯一建档
// - 里程碑证据必须登记在册且已获分享授权；试点成果只能被归属档案申报
// - 进入试点须伙伴尽调通过并逐项确认责任
// - 正式合同前必须先有验收通过里程碑
// - 异常必须带原因；意向失效档案必须保留失效记录
// - 市场准入受阻必须挂起未决监管前置条件，且不得与「没有跟进」混淆

const MILESTONE_ORDER = [
  'intent_recorded',
  'partner_diligence_done',
  'pilot_agreement_signed',
  'pilot_launched',
  'pilot_interim_report',
  'acceptance_passed',
  'contract_signed',
];

const PILOT_STAGES = new Set(['pilot_agreed', 'piloting', 'acceptance', 'contracted']);

function fail(errors, where, message) {
  errors.push(`${where}：${message}`);
}

export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const errors = [];

  for (const field of ['domain', 'version', 'sample_id', 'actors', 'facts', 'constraints', 'engagements', 'evidence_inventory']) {
    if (value[field] === undefined || value[field] === null) {
      throw new Error(`共享资料缺少必要字段：${field}`);
    }
  }
  if (!Array.isArray(value.actors) || value.actors.length < 2) {
    throw new Error('共享资料缺少必要字段：actors');
  }
  if (!Array.isArray(value.facts) || value.facts.length < 2) {
    throw new Error('共享资料缺少必要字段：facts');
  }
  if (!Array.isArray(value.constraints) || value.constraints.length < 2) {
    throw new Error('共享资料缺少必要字段：constraints');
  }
  if (!Array.isArray(value.engagements) || value.engagements.length === 0) {
    throw new Error('共享资料缺少必要字段：engagements');
  }
  if (!Array.isArray(value.evidence_inventory)) {
    throw new Error('共享资料缺少必要字段：evidence_inventory');
  }

  const evidenceById = validateEvidenceInventory(value.engagements, value.evidence_inventory, errors);
  validateEngagements(value, evidenceById, errors);

  if (errors.length > 0) {
    throw new Error(`领域校验未通过（${errors.length}项）：\n- ${errors.join('\n- ')}`);
  }
  return value;
}

function validateEvidenceInventory(engagements, inventory, errors) {
  const evidenceById = new Map();
  const engagementIds = new Set(engagements.map((e) => e.engagement_id));

  for (const ev of inventory) {
    if (!ev || !ev.evidence_id) {
      fail(errors, '证据清单', '存在缺少 evidence_id 的材料');
      continue;
    }
    if (evidenceById.has(ev.evidence_id)) {
      fail(errors, `证据 ${ev.evidence_id}`, '证据编号重复');
    }
    evidenceById.set(ev.evidence_id, ev);
    if (!engagementIds.has(ev.owner_engagement_id)) {
      fail(errors, `证据 ${ev.evidence_id}`, `归属档案 ${ev.owner_engagement_id} 不存在`);
    }
  }
  return evidenceById;
}

function validateEngagements(value, evidenceById, errors) {
  const seenKeys = new Set();
  const seenIds = new Set();

  for (const eng of value.engagements) {
    const where = `档案 ${eng.engagement_id || '(无编号)'}`;

    if (!eng.engagement_id) {
      fail(errors, '档案', '缺少 engagement_id');
      continue;
    }
    if (seenIds.has(eng.engagement_id)) {
      fail(errors, where, '档案编号重复');
    }
    seenIds.add(eng.engagement_id);

    const key = `${eng.company}@@${eng.country_code}`;
    if (seenKeys.has(key)) {
      fail(errors, where, `企业 ${eng.company} 在 ${eng.country_code} 已有档案，不得重复建档`);
    }
    seenKeys.add(key);

    validatePartnerAndPilot(eng, where, errors);
    validatePrerequisites(eng, where, evidenceById, errors);
    validateMilestones(eng, where, evidenceById, errors);
    validateExceptions(eng, where, errors);
    validateBlocking(eng, where, errors);
    validateCommercial(eng, where, errors);
  }
}

function validatePartnerAndPilot(eng, where, errors) {
  const hasPilotAgreement = Boolean(eng.pilot_agreement);
  const reachedPilot = (eng.milestones || []).some((m) =>
    ['pilot_agreement_signed', 'pilot_launched', 'pilot_interim_report', 'acceptance_passed', 'contract_signed'].includes(m.code),
  );
  const enteredPilot = PILOT_STAGES.has(eng.stage) || hasPilotAgreement || reachedPilot;

  if (!enteredPilot) return;

  if (!eng.partner) {
    fail(errors, where, '进入试点阶段必须登记本地合作方及其尽调结果');
    return;
  }
  const dd = eng.partner.due_diligence || {};
  if (dd.status !== 'passed' && dd.status !== 'passed_with_conditions') {
    fail(errors, where, '合作方尽调未通过，不得进入试点');
  }
  const responsibilities = eng.partner.responsibilities || [];
  if (responsibilities.length === 0) {
    fail(errors, where, '合作方必须逐项确认自身责任后才能进入试点');
  }
  for (const r of responsibilities) {
    if (!r.confirmed) {
      fail(errors, where, `合作方责任「${r.item}」尚未经伙伴确认`);
    }
  }
  if (hasPilotAgreement && !reachedPilot) {
    fail(errors, where, '已签试点协议但缺少试点协议签署里程碑');
  }
  if (!hasPilotAgreement && reachedPilot) {
    fail(errors, where, '存在试点及以后里程碑但缺少试点协议记录');
  }
}

function validatePrerequisites(eng, where, evidenceById, errors) {
  for (const pre of eng.regulatory_prerequisites || []) {
    if (pre.status === 'resolved') {
      if (!pre.evidence_ref) {
        fail(errors, where, `监管前置条件 ${pre.id} 标记已解决但缺少证据引用`);
        continue;
      }
      const ev = evidenceById.get(pre.evidence_ref);
      if (!ev) {
        fail(errors, where, `监管前置条件 ${pre.id} 引用了未登记材料 ${pre.evidence_ref}`);
      } else if (ev.authorization === 'not_shared') {
        fail(errors, where, `监管前置条件 ${pre.id} 引用了未授权分享的材料`);
      }
    }
  }
}

function validateMilestones(eng, where, evidenceById, errors) {
  let lastOrder = -1;
  let lastDate = '';
  const ownerId = eng.engagement_id;

  for (const m of eng.milestones || []) {
    const order = MILESTONE_ORDER.indexOf(m.code);
    if (order < 0) {
      fail(errors, where, `未知里程碑类型 ${m.code}`);
      continue;
    }
    if (order < lastOrder) {
      fail(errors, where, `里程碑 ${m.code} 早于前一里程碑，生命周期顺序错误`);
    }
    if (m.reached_on < lastDate) {
      fail(errors, where, `里程碑 ${m.code} 的达成日期早于前一里程碑`);
    }
    lastOrder = order;
    lastDate = m.reached_on;

    for (const ref of m.evidence_refs || []) {
      const ev = evidenceById.get(ref);
      if (!ev) {
        fail(errors, where, `里程碑 ${m.code} 引用了未登记材料 ${ref}`);
        continue;
      }
      if (ev.authorization === 'not_shared') {
        fail(errors, where, `里程碑 ${m.code} 不得引用未授权分享的材料 ${ref}`);
      }
      // 活动层级材料可用于各档案的意向登记；其余证据只能由归属档案申报，
      // 防止同一试点成果被不同国家或企业重复申报。
      const isEventLevel = ev.kind === '活动记录' && m.code === 'intent_recorded';
      if (ev.owner_engagement_id !== ownerId && !isEventLevel) {
        fail(errors, where, `里程碑 ${m.code} 引用了归属其他档案的材料 ${ref}，试点成果不得重复申报`);
      }
    }
  }
}

function validateExceptions(eng, where, errors) {
  for (const ex of eng.exceptions || []) {
    if (!ex.reason || !ex.reason.trim()) {
      fail(errors, where, `异常 ${ex.type} 必须记录原因`);
    }
    if (!ex.date) {
      fail(errors, where, `异常 ${ex.type} 必须记录发生日期`);
    }
  }
  if (eng.stage === 'lapsed') {
    const lapsed = (eng.exceptions || []).some((ex) => ex.type === 'intent_lapsed' && ex.reason);
    if (!lapsed) {
      fail(errors, where, '意向失效档案必须记录意向失效异常及原因');
    }
  }
}

function validateBlocking(eng, where, errors) {
  const blocking = eng.blocking;
  if (!blocking) return;

  const pendingIds = new Set(
    (eng.regulatory_prerequisites || []).filter((p) => p.status === 'pending').map((p) => p.id),
  );

  if (blocking.type === 'market_access') {
    const refs = blocking.prerequisite_ids || [];
    if (refs.length === 0) {
      fail(errors, where, '市场准入受阻必须挂起至少一项未决监管前置条件');
    }
    for (const id of refs) {
      if (!pendingIds.has(id)) {
        fail(errors, where, `市场准入阻塞挂起的 ${id} 不是本档案未决的监管前置条件`);
      }
    }
  }

  if (blocking.type === 'followup_gap' && pendingIds.size > 0) {
    fail(errors, where, `存在未决监管前置条件（${[...pendingIds].join('、')}），应归类为市场准入受阻而非没有跟进`);
  }
}

function validateCommercial(eng, where, errors) {
  const codes = new Set((eng.milestones || []).map((m) => m.code));
  const commercial = eng.commercial || {};

  if (commercial.status === 'contracted' || codes.has('contract_signed')) {
    if (!codes.has('acceptance_passed')) {
      fail(errors, where, '登记正式合同前必须先有验收通过里程碑');
    }
    if (commercial.status !== 'contracted') {
      fail(errors, where, '已有合同签署里程碑但商业转化状态未登记为 contracted');
    }
    if (codes.has('contract_signed') && commercial.status === 'contracted' && !commercial.contract_ref) {
      fail(errors, where, '已签约档案必须登记合同编号');
    }
  }
}
