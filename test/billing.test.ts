// 内测免费 / 试用与会员 / 早鸟限量 / 邀请奖励 / 后台开关（独立的临时数据库）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-billing-"));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USER_IDS = "999";
delete process.env.FREE_BETA;

const db = await import("../auth/db.ts");
const { accessStatus, recordUsage, usageCount } = await import("../billing/access.ts");
const { betaFree, betaEndedAt, setSetting, siteSettings } = await import("../billing/settings.ts");
const { publicPlan, wechatGroupInfo } = await import("../billing/plan.ts");
const { createOrder, closeOrder, getOrder, processPayment, listOrders } = await import("../billing/orders.ts");
const { earlyBirdStats, listPlans } = await import("../billing/catalog.ts");
const { claimReferral, referralSummary, referralCode, settlePendingReferrals } = await import("../billing/referral.ts");
const { applyBetaFree, isAdmin } = await import("../billing/admin.ts");
const { grantEntitlement } = await import("../auth/entitlements.ts");
const { q, transaction } = db;

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const mkUser = (name: string, createdAgoSec = 0) => Number(q("INSERT INTO users (display_name, created_at) VALUES (?, ?)").run(name, nowSec() - createdAgoSec).lastInsertRowid);
const U = (id: number) => q("SELECT * FROM users WHERE id = ?").get(id);
const pay = (o: any, ev = `ev-${o.merchant_order_no}`) => processPayment({ provider: "manual", eventId: ev, merchantOrderNo: o.merchant_order_no, amountCents: o.amount_cents, currency: o.currency, providerTxnId: ev, payload: "{}" });

after(() => { try { db.db.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

test("内测免费默认开：试用已过期的用户也放行，但试用状态照常计算", () => {
  assert.equal(betaFree(), true);
  const u = U(mkUser("old", 10 * DAY));
  const a = accessStatus(u);
  assert.equal(a.allowed, true); assert.equal(a.beta, true); assert.equal(a.member, false);
  assert.equal(a.trial.active, false); assert.equal(a.daysLeft, 0); assert.equal(a.reason, undefined);
  assert.equal(publicPlan().beta, true);
});

test("公开方案：早鸟（限量、永久）在前，常规方案在后，附剩余名额与邀请天数", () => {
  const p = publicPlan();
  assert.equal(p.plans.length, 2);
  assert.equal(p.plans[0].code, "earlybird"); assert.equal(p.plans[0].mode, "permanent"); assert.equal(p.plans[0].priceCents, 9900); assert.equal(p.plans[0].limit, 200); assert.equal(p.plans[0].left, 200);
  assert.equal(p.plans[1].code, "monthly"); assert.equal(p.plans[1].limit, null);
  assert.equal(p.referralDays, 7);
  assert.equal((p as any).wechatGroup, undefined, "微信群入口不对匿名访客公开");
  assert.equal(wechatGroupInfo(), null);
});

test("内测期间的邀请：登记但不发放；关闭内测时统一发放，双方各得 7 天", () => {
  const inviter = mkUser("inviter"), invitee = mkUser("invitee");
  const code = referralCode(inviter);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(referralCode(inviter), code, "邀请码稳定");
  const r = transaction(() => claimReferral(invitee, code.toLowerCase()));
  assert.equal(r.settled_at, null); assert.equal(r.inviter_days, 7); assert.equal(r.invitee_days, 7);
  assert.equal(accessStatus(U(invitee)).member, false, "内测期间未发放");
  assert.throws(() => transaction(() => claimReferral(invitee, code)), /already_referred/);
  assert.throws(() => transaction(() => claimReferral(inviter, code)), /self_referral/);
  assert.throws(() => transaction(() => claimReferral(mkUser("x"), "ZZZZZZZZ")), /unknown_code/);
  assert.throws(() => transaction(() => claimReferral(mkUser("late", 8 * DAY), code)), /claim_window_closed/);
  const sum = referralSummary(inviter);
  assert.equal(sum.invited, 1); assert.equal(sum.earnedDays, 7); assert.equal(sum.pendingDays, 7); assert.equal(sum.canClaim, true);
  assert.equal(referralSummary(invitee).claimed?.settled, false);

  const settled = transaction(() => applyBetaFree(false));
  assert.equal(settled, 1);
  assert.equal(betaFree(), false);
  assert.ok(betaEndedAt() >= nowSec() - 5);
  for (const id of [inviter, invitee]) {
    const a = accessStatus(U(id));
    assert.equal(a.member, true); assert.equal(a.daysLeft, 7); assert.equal(a.permanent, false);
  }
  assert.equal(transaction(() => settlePendingReferrals()), 0, "幂等");
  assert.equal(referralSummary(inviter).pendingDays, 0);
  // 内测关闭后再邀请：立即发放
  const u3 = mkUser("fresh");
  const r2 = transaction(() => claimReferral(u3, code));
  assert.ok(r2.settled_at);
  assert.equal(accessStatus(U(u3)).daysLeft, 7);
  assert.equal(accessStatus(U(inviter)).daysLeft, 14, "邀请者顺延累加");
});

test("内测关闭后：试用从关闭时起重新计算，到期 / 次数用完即拒绝；会员到期后拒绝", () => {
  const t0 = betaEndedAt();
  const old = U(mkUser("beta-user", 30 * DAY));
  const a = accessStatus(old);
  assert.equal(a.beta, false); assert.equal(a.allowed, true); assert.equal(a.trial.active, true);
  assert.equal(a.trial.startsAt, t0, "试用从内测结束时起算"); assert.equal(a.daysLeft, 3);
  // 内测期间的用量不计
  q("INSERT INTO usage_events (user_id, kind, ref, created_at) VALUES (?, 'run', 'x', ?)").run(old.id, t0 - 100);
  assert.equal(usageCount(old.id, "run", t0), 0);
  for (let i = 0; i < 5; i++) recordUsage(old, "r" + i);
  const b = accessStatus(old);
  assert.equal(b.allowed, false); assert.equal(b.reason, "trial_exhausted");
  const fresh = U(mkUser("fresh2"));
  const c = accessStatus(fresh, nowSec() + 4 * DAY);
  assert.equal(c.allowed, false); assert.equal(c.reason, "trial_expired"); assert.equal(c.daysLeft, 0);
  // 会员 10 天：到期后拒绝
  transaction(() => grantEntitlement({ userId: fresh.id, entitlement: "member", sourceType: "test", sourceRef: "m10", mode: "days", days: 10 }));
  assert.equal(accessStatus(fresh, nowSec() + 4 * DAY).allowed, true);
  assert.equal(accessStatus(fresh, nowSec() + 9 * DAY).daysLeft, 1);
  const d = accessStatus(fresh, nowSec() + 11 * DAY);
  assert.equal(d.allowed, false); assert.equal(d.member, false); assert.equal(d.reason, "trial_expired");
});

test("早鸟终身版：限量计数（已付 + 24 小时内待支付），售罄后拒单，付款后永久会员", () => {
  setSetting("early_bird_limit", "2");
  assert.equal(earlyBirdStats().left, 2);
  const u1 = mkUser("eb1"), u2 = mkUser("eb2"), u3 = mkUser("eb3");
  const o1 = transaction(() => createOrder(u1, "earlybird"));
  assert.equal(o1.plan_code, "earlybird"); assert.equal(o1.amount_cents, 9900);
  assert.deepEqual(earlyBirdStats(), { limit: 2, sold: 0, reserved: 1, left: 1 });
  const o2 = transaction(() => createOrder(u2, "earlybird"));
  assert.equal(earlyBirdStats().left, 0);
  assert.throws(() => transaction(() => createOrder(u3, "earlybird")), /sold_out/);
  assert.throws(() => transaction(() => createOrder(u3, "nope")), /unknown_plan/);
  const o3 = transaction(() => createOrder(u3));   // 常规方案不受名额限制
  assert.equal(o3.plan_code, "monthly"); assert.equal(o3.amount_cents, 1800);
  assert.equal(pay(o1), "processed"); assert.equal(pay(o1), "duplicate");
  const a = accessStatus(U(u1));
  assert.equal(a.member, true); assert.equal(a.permanent, true); assert.equal(a.daysLeft, null);
  assert.deepEqual(earlyBirdStats(), { limit: 2, sold: 1, reserved: 1, left: 0 });
  assert.equal(pay(o3), "processed");
  assert.equal(accessStatus(U(u3)).daysLeft, 30);
  assert.equal(listOrders(u1)[0].plan_code, "earlybird");
  assert.equal(publicPlan().plans[0].left, 0);
  // 过期的待支付订单释放名额
  q("UPDATE orders SET created_at = created_at - 2 * 86400 WHERE merchant_order_no = ?").run(o2.merchant_order_no);
  assert.equal(earlyBirdStats().left, 1);
  // 名额被别人买走后，过期订单即使付款也不发放（订单保持待支付，由站主退款或手动赠送）
  const u4 = mkUser("eb4");
  const o4 = transaction(() => createOrder(u4, "earlybird"));
  assert.equal(pay(o4), "processed");
  assert.deepEqual(earlyBirdStats(), { limit: 2, sold: 2, reserved: 0, left: 0 });
  assert.throws(() => pay(o2), /sold_out/);
  assert.equal(getOrder(o2.merchant_order_no).status, "pending");
  assert.equal(accessStatus(U(u2)).member, false);
  assert.equal(q("SELECT COUNT(*) AS c FROM payment_events WHERE event_id = ?").get(`ev-${o2.merchant_order_no}`).c, 0, "失败的发放不留下支付事件");
  // 过期的待支付订单可被关闭；关闭后不能再确认到账
  closeOrder(o2.merchant_order_no);
  assert.equal(getOrder(o2.merchant_order_no).status, "closed");
  assert.throws(() => pay(o2, "ev-again"), /order_not_pending/);
  setSetting("early_bird_limit", null);
});

test("后台：设置键值回落到 .env；管理员判定；重新开启内测后全部放行", () => {
  const s = siteSettings();
  assert.equal(s.earlyBirdLimit, 200); assert.equal(s.payInstructions, ""); assert.equal(s.referralDays, 7);
  setSetting("pay_instructions", "扫码付款并备注订单号"); setSetting("wechat_group_note", "加群");
  assert.equal(siteSettings().payInstructions, "扫码付款并备注订单号");
  assert.deepEqual(wechatGroupInfo(), { qrUrl: "", note: "加群" });
  assert.equal(isAdmin({ id: 999 }), true); assert.equal(isAdmin({ id: 1 }), false); assert.equal(isAdmin(null), false);
  transaction(() => grantEntitlement({ userId: 1, entitlement: "admin", sourceType: "test", sourceRef: "adm", mode: "permanent" }));
  assert.equal(isAdmin({ id: 1 }), true);
  transaction(() => applyBetaFree(true));
  const u = U(mkUser("after", 40 * DAY));
  assert.equal(accessStatus(u).allowed, true); assert.equal(accessStatus(u).beta, true);
});
