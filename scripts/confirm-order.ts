// 站主手动确认收款（线下转账 / 扫码付款）：node scripts/confirm-order.ts <订单号> [凭证号]
import { getOrder, processPayment } from "../billing/orders.ts";
const [no, txn = ""] = process.argv.slice(2);
if (!no) { console.error("用法: <订单号> [凭证号]"); process.exit(1); }
const o = getOrder(no);
if (!o) { console.error("订单不存在"); process.exit(1); }
const r = processPayment({ provider: "manual", eventId: `manual-${no}`, merchantOrderNo: no, amountCents: o.amount_cents, currency: o.currency, providerTxnId: txn || `manual-${Date.now()}`, payload: JSON.stringify({ by: "cli", at: new Date().toISOString() }) });
console.log(r === "processed" ? `订单 ${no} 已确认，权益已发放给用户 ${o.user_id}` : `订单 ${no} 之前已处理`);
