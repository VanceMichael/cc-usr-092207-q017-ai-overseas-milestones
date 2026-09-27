import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDomain } from '../src/domain.js';

const FIXTURE_URL = new URL('../fixtures/domain.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
}

// 深拷贝并重新序列化，方便在合法样例上做单点破坏。
async function mutate(mutator) {
  const value = await loadFixture();
  mutator(value);
  return value;
}

function expectDomainError(value, fragment) {
  assert.throws(
    () => parseDomain(JSON.stringify(value)),
    (err) => err.message.includes(fragment),
    `应抛出包含「${fragment}」的领域校验错误`,
  );
}

test('合法样例通过全部领域校验', async () => {
  const raw = await readFile(FIXTURE_URL, 'utf8');
  const value = parseDomain(raw);
  assert.equal(value.domain, 'ai-overseas-milestones');
  assert.equal(value.version, 2);
  assert.ok(value.engagements.length >= 4);
});

test('同一企业同一国家不得重复建档', async () => {
  const value = await mutate((v) => {
    const dup = JSON.parse(JSON.stringify(v.engagements.find((e) => e.engagement_id === 'E-SL-TH')));
    dup.engagement_id = 'E-SL-TH-2';
    v.engagements.push(dup);
  });
  expectDomainError(value, '不得重复建档');
});

test('同一试点证据不得被其他国家档案重复申报', async () => {
  const value = await mutate((v) => {
    // 泰国档案试图把新加坡的中期报告当作自己的里程碑证据
    const thai = v.engagements.find((e) => e.engagement_id === 'E-KH-TH');
    thai.milestones.push({
      id: 'M-KHTH-X',
      code: 'pilot_interim_report',
      name: '冒用新加坡中期报告',
      reached_on: '2026-07-01',
      evidence_refs: ['EVD-KHSG-INTERIM'],
    });
  });
  expectDomainError(value, '试点成果不得重复申报');
});

test('里程碑不得引用未授权分享的材料', async () => {
  const value = await mutate((v) => {
    const my = v.engagements.find((e) => e.engagement_id === 'E-QH-MY');
    my.milestones[my.milestones.length - 1].evidence_refs.push('EVD-QHMY-RAW');
  });
  expectDomainError(value, '未授权分享');
});

test('里程碑不得引用未登记材料', async () => {
  const value = await mutate((v) => {
    const sg = v.engagements.find((e) => e.engagement_id === 'E-KH-SG');
    sg.milestones[0].evidence_refs = ['EVD-NOT-EXISTS'];
  });
  expectDomainError(value, '未登记材料');
});

test('进入试点前合作方尽调必须通过', async () => {
  const value = await mutate((v) => {
    const thai = v.engagements.find((e) => e.engagement_id === 'E-KH-TH');
    thai.partner.due_diligence.status = 'failed';
  });
  expectDomainError(value, '尽调未通过');
});

test('伙伴责任未经确认不得进入试点', async () => {
  const value = await mutate((v) => {
    const sg = v.engagements.find((e) => e.engagement_id === 'E-KH-SG');
    sg.partner.responsibilities[0].confirmed = false;
  });
  expectDomainError(value, '尚未经伙伴确认');
});

test('正式合同前必须先验收通过', async () => {
  const value = await mutate((v) => {
    const sg = v.engagements.find((e) => e.engagement_id === 'E-KH-SG');
    sg.milestones = sg.milestones.filter((m) => m.code !== 'acceptance_passed');
  });
  expectDomainError(value, '登记正式合同前必须先有验收通过');
});

test('异常必须记录原因', async () => {
  const value = await mutate((v) => {
    const lapsed = v.engagements.find((e) => e.engagement_id === 'E-SL-SG');
    lapsed.exceptions[0].reason = '   ';
  });
  expectDomainError(value, '必须记录原因');
});

test('意向失效档案必须保留失效原因', async () => {
  const value = await mutate((v) => {
    const lapsed = v.engagements.find((e) => e.engagement_id === 'E-SL-SG');
    lapsed.exceptions = [];
  });
  expectDomainError(value, '意向失效档案必须记录意向失效异常');
});

test('市场准入受阻必须挂起未决监管前置条件', async () => {
  const value = await mutate((v) => {
    const thai = v.engagements.find((e) => e.engagement_id === 'E-KH-TH');
    thai.blocking.prerequisite_ids = [];
  });
  expectDomainError(value, '市场准入受阻必须挂起');
});

test('挂起的前置条件必须确实未决', async () => {
  const value = await mutate((v) => {
    const thai = v.engagements.find((e) => e.engagement_id === 'E-KH-TH');
    thai.blocking.prerequisite_ids = ['TH-R1'];
    thai.regulatory_prerequisites[0].status = 'resolved';
    thai.regulatory_prerequisites[0].evidence_ref = 'EVD-KHTH-DD';
  });
  expectDomainError(value, '不是本档案未决的监管前置条件');
});

test('有未决监管事项时不得归类为没有跟进', async () => {
  const value = await mutate((v) => {
    const intent = v.engagements.find((e) => e.engagement_id === 'E-SL-TH');
    intent.regulatory_prerequisites = [{ id: 'TH-X1', item: '数据许可咨询', status: 'pending' }];
  });
  expectDomainError(value, '应归类为市场准入受阻');
});

test('已解决的监管前置条件必须附证据', async () => {
  const value = await mutate((v) => {
    const sg = v.engagements.find((e) => e.engagement_id === 'E-KH-SG');
    delete sg.regulatory_prerequisites[0].evidence_ref;
  });
  expectDomainError(value, '标记已解决但缺少证据引用');
});

test('里程碑生命周期顺序不可颠倒', async () => {
  const value = await mutate((v) => {
    const sg = v.engagements.find((e) => e.engagement_id === 'E-KH-SG');
    const launch = sg.milestones.find((m) => m.code === 'pilot_launched');
    launch.code = 'acceptance_passed';
    launch.reached_on = '2026-04-15';
  });
  expectDomainError(value, '生命周期顺序错误');
});

test('活动层级意向登记证据可被各国家档案引用', async () => {
  const raw = await readFile(FIXTURE_URL, 'utf8');
  const value = parseDomain(raw);
  const intentRefs = value.engagements
    .flatMap((e) => e.milestones)
    .filter((m) => m.code === 'intent_recorded')
    .flatMap((m) => m.evidence_refs);
  assert.ok(intentRefs.every((ref) => ref === 'EVD-EVENT-001'));
});
