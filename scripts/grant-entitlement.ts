// 用法：node scripts/grant-entitlement.ts <userId> <entitlement> <days|permanent> [备注]
import { transaction } from "../auth/db.ts";
import { grantEntitlement } from "../auth/entitlements.ts";
const [userId, entitlement, period, note = ""] = process.argv.slice(2);
if (!userId || !entitlement || !period) { console.error("用法: <userId> <entitlement> <days|permanent> [备注]"); process.exit(1); }
const id = transaction(() => grantEntitlement({ userId: Number(userId), entitlement, sourceType: "manual", sourceRef: `cli-${Date.now()}-${note}`,
  mode: period === "permanent" ? "permanent" : "days", days: period === "permanent" ? null : Number(period) }));
console.log("granted id=", id);
