// 查看用户与权益：npm run users
import { q } from "../auth/db.ts";
import { accessStatus } from "../billing/access.ts";
import { betaFree } from "../billing/settings.ts";
console.log(betaFree() ? "内测免费：开（所有用户可用；下表的剩余天数为内测结束后的参考值）" : "内测免费：关（按会员 / 试用规则放行）");
for (const u of q("SELECT * FROM users ORDER BY id").all()) {
  const a = accessStatus(u);
  const status = a.member ? (a.permanent ? "永久会员" : "会员至 " + new Date((a.memberUntil as number) * 1000).toLocaleDateString("zh-CN")) : a.trial.active ? `试用中（剩 ${a.trial.usesLeft} 次）` : a.reason === "trial_exhausted" ? "试用次数用完" : "试用已结束";
  console.log(`#${u.id}\t${u.display_name ?? "-"}\t注册 ${new Date(u.created_at * 1000).toLocaleString("zh-CN")}\t已用 ${a.trial.used} 次\t${status}\t剩余 ${a.daysLeft == null ? "永久" : a.daysLeft + " 天"}`);
}
