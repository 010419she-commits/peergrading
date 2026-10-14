// 查看用户与权益：node scripts/list-users.ts
import { q } from "../auth/db.ts";
import { entitlementSummary } from "../auth/entitlements.ts";
import { usageCount } from "../billing/access.ts";
for (const u of q("SELECT id, display_name, created_at FROM users ORDER BY id").all()) {
  const m = entitlementSummary(u.id).find((e) => e.code === "member");
  console.log(`#${u.id}\t${u.display_name ?? "-"}\t注册 ${new Date(u.created_at * 1000).toLocaleString("zh-CN")}\t已用 ${usageCount(u.id)} 次\t会员 ${m?.active ? (m.permanentNow ? "永久" : "至 " + new Date(m.continuousUntil * 1000).toLocaleDateString("zh-CN")) : "否"}`);
}
