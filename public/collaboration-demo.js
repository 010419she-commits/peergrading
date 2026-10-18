/* Four-step local/cloud collaboration demo; all state stays in this page. */
(() => {
  "use strict";
  const root = document.getElementById("collaboration-demo");
  if (!root) return;

  const dictionaries = window.SITE_I18N || {};
  const lang = "en";
  const t = (key) => dictionaries[lang]?.[key] ?? dictionaries.zh?.[key] ?? key;
  const status = root.querySelector("#loop-status");
  const title = root.querySelector("#loop-stage-title");
  const copy = root.querySelector("#loop-stage-copy");
  const controls = root.querySelector("#loop-controls");
  const next = root.querySelector("#loop-next");
  const reset = root.querySelector("#loop-reset");
  const steps = Array.from(root.querySelectorAll("[data-loop-step]"))
    .filter((button) => /^[0-3]$/.test(button.dataset.loopStep));
  if (!status || !title || !copy || !steps.length) return;

  let stage = 0;
  let round = 1;
  const render = () => {
    root.dataset.demoStage = String(stage);
    steps.forEach((button) => {
      const selected = Number(button.dataset.loopStep) === stage;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-active", selected);
    });
    root.querySelectorAll("[data-loop-actor]").forEach((actor) => {
      const active = stage === 0 || stage === 3 ? "local" : "cloud";
      actor.classList.toggle("is-active", actor.dataset.loopActor === active);
    });
    status.textContent = t("hybridLoopStatus")
      .replaceAll("{round}", String(round))
      .replaceAll("{step}", String(stage + 1));
    title.textContent = t(`hybridStage${stage + 1}Title`);
    copy.textContent = t(`hybridStage${stage + 1}Body`);
    if (next) next.textContent = t(stage === 3 ? "hybridNextRound" : "hybridNext");
  };

  steps.forEach((button) => {
    button.disabled = false;
    button.addEventListener("click", () => {
      stage = Number(button.dataset.loopStep);
      render();
    });
  });
  next?.addEventListener("click", () => {
    if (stage === 3) {
      stage = 0;
      round += 1;
    } else stage += 1;
    render();
  });
  reset?.addEventListener("click", () => {
    stage = 0;
    round = 1;
    render();
  });
  if (reset) reset.textContent = t("hybridReset");
  render();
  if (controls) controls.hidden = false;
})();
