import { init } from "@airwallex/components-sdk";

// PaymentIntent client secrets are scoped to a single checkout. Card data stays on Airwallex.
window.PeerGradingCards = {
  async checkout(checkout: any, lang: string) {
    if (!["demo", "prod"].includes(checkout.env) || !checkout.intentId || !checkout.clientSecret) throw new Error("invalid_checkout");
    const success = new URL(checkout.successUrl);
    if (success.origin !== location.origin || success.pathname !== "/account") throw new Error("invalid_return_url");
    const { payments } = await init({ env: checkout.env, locale: lang === "zh" ? "zh" : "en", enabledElements: ["payments"] });
    if (!payments) throw new Error("payment_sdk_unavailable");
    payments.redirectToCheckout({
      intent_id: checkout.intentId, client_secret: checkout.clientSecret,
      currency: checkout.currency, country_code: checkout.countryCode,
      methods: ["card"], allowedCardNetworks: ["visa", "mastercard"],
      successUrl: success.href, mode: "payment", autoCapture: true, autoSaveCardForFuturePayments: false,
    });
  },
};
