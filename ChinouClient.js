/**
 * ChinouClient — GLOBAL-scope ServiceNow Script Include (paste into the instance, not part of the
 * x_nose_nfotc Fluent app). Corrected + hardened client for the Chinou LLM.
 *
 * WHERE IT LIVES (nomuraevalinstancegenaipov):
 *   System Definition -> Script Includes -> ChinouClient
 *     Name: ChinouClient · Application: Global · Accessible from: All application scopes · Active: true
 *   Paste this whole file's code into the Script field -> Update.
 *
 * DEFAULT MODEL (chosen 2026-08-14): anthropic-5-sonnet[Bedrock]  (Claude Sonnet 5)
 *   Set the property so every call defaults to it:
 *     sys_properties.list -> chinou.model.id = anthropic-5-sonnet[Bedrock]
 *   Per-call override: new global.ChinouClient().invoke(prompt, 'anthropic-5-opus[Bedrock]')
 *
 * KNOWN-GOOD MODELS on this Chinou (2026-08-14): 4.5-haiku/sonnet/opus, 4.6-sonnet/opus,
 *   5-sonnet, 5-opus.  NOTE: the "5.0-*" strings are DECOMMISSIONED — use plain "5-".
 *   Errors come back as HTTP 200 with an { "LLMError": ... } body, so this client checks the body,
 *   not just the status code.
 *
 * QUICK TEST (Scripts - Background, Global scope, "Execute in sandbox?" unchecked):
 *   var r = new global.ChinouClient().invoke('Reply with exactly: CHINOU OK');
 *   gs.info('[TEST] ' + JSON.stringify(r));   // expect success:true, response "CHINOU OK", model 5-sonnet
 */
var ChinouClient = Class.create();
ChinouClient.prototype = {
    initialize: function () {},

    DEFAULT_MODEL: 'anthropic-5-sonnet[Bedrock]',

    /**
     * POST a text prompt to Chinou via the 'Chinou API' REST Message ('invoke' function — direct REST
     * route, Bearer auth already on the function's headers). Correct chinou-json:1 contract.
     * @param {string} prompt  the text to send
     * @param {string} [model] optional per-call model override (e.g. 'anthropic-5-opus[Bedrock]');
     *                         falls back to the chinou.model.id property, then DEFAULT_MODEL.
     */
    invoke: function (prompt, model) {
        try {
            model = model || gs.getProperty('chinou.model.id', this.DEFAULT_MODEL);
            var regId = gs.getProperty('chinou.reg.id', '');

            var requestBody = {
                "_protocol": "chinou-json:1",
                "LLMRequest": {
                    "sessionId": "",
                    "LLMDescriptor": {
                        "model": model,
                        "model_params": { "temperature": 0.3, "top_k": 1.0, "max_tokens": 8192 }
                    },
                    "body": "" + (prompt || "")
                }
            };

            // Use-case Registration ID for AI CoE usage/cost attribution. Verified 2026-09-04 against the
            // LIVE API: it MUST go in LLMRequest.parameters — a query param (and every other body spot) is
            // ignored and Chinou keeps returning the "Include the Registration ID" warning. Ref confluence
            // .../x/1ZJuYQ; property chinou.reg.id = AIUC00337 (the AI field-extraction capability — which is
            // what actually makes these calls; AIUC00336 is the parent Compare & Match use case).
            if (regId) { requestBody.LLMRequest.parameters = { "reg_id": regId }; }

            var request = new sn_ws.RESTMessageV2('Chinou API', 'invoke');
            request.setRequestBody(JSON.stringify(requestBody));
            request.setHttpTimeout(60000);

            var response = request.execute();
            var httpStatus = response.getStatusCode();
            var responseBody = response.getBody();
            gs.info('[ChinouClient] model=' + model + ' status=' + httpStatus);

            if (httpStatus != 200) {
                gs.error('[ChinouClient] HTTP ' + httpStatus + ': ' + responseBody);
                return { success: false, status: httpStatus, model: model, error: 'HTTP ' + httpStatus + ': ' + responseBody };
            }

            var json = JSON.parse(responseBody);

            // Chinou returns API errors as HTTP 200 + an { "LLMError": {...} } body (e.g. a decommissioned
            // model). Catch it here so a failure can never look like an empty success.
            if (json.LLMError) {
                var em = json.LLMError.message || json.LLMError.code || 'LLMError';
                gs.error('[ChinouClient] LLMError: ' + em);
                return { success: false, status: httpStatus, model: model, error: 'LLMError: ' + em };
            }

            // Real answer lives in the richer LLMDocuResponse envelope (or the plainer LLMResponse).
            var env = json.LLMDocuResponse || json.LLMResponse;
            if (!env) {
                gs.error('[ChinouClient] unexpected response shape: ' + ('' + responseBody).substring(0, 300));
                return { success: false, status: httpStatus, model: model, error: 'Unexpected response: ' + ('' + responseBody).substring(0, 300) };
            }

            // Guardrail: only a RESPOND decision is a usable answer; anything else is a block.
            var decision = (env.ComplianceChecks && env.ComplianceChecks.Decision) ? env.ComplianceChecks.Decision : null;
            if (decision && decision.decision && ('' + decision.decision).toUpperCase() !== 'RESPOND') {
                gs.warn('[ChinouClient] guardrail blocked: ' + decision.decision + ' (' + (decision.reason || '') + ')');
                return { success: false, status: httpStatus, model: model, blocked: true,
                         error: 'Guardrail: ' + decision.decision + (decision.reason ? (' - ' + decision.reason) : '') };
            }

            var text = (typeof env.body === 'string') ? env.body : '';
            var metrics = env.metrics || {};
            return { success: true, status: httpStatus, response: text, model: model,
                     costUsd: metrics.cost, responseTimeMs: metrics.execution_time_ms };
        } catch (ex) {
            gs.error('[ChinouClient] exception: ' + (ex.message || ex));
            return { success: false, status: 0, model: model, error: 'Exception: ' + (ex.message || ex) };
        }
    },

    // Convenience helper: extract Currency + Reference from text (works via the fixed invoke).
    extractCurrencyAndReference: function (emailText, model) {
        var prompt = 'You are a document processing expert. From the TEXT, extract:\n' +
            '1. Currency - any ISO currency code (USD, EUR, GBP, JPY, ...)\n' +
            '2. Reference - any reference / invoice / transaction ids\n\n' +
            'TEXT:\n' + ('' + (emailText || '')) + '\n\n' +
            'Respond EXACTLY as:\nCurrency: [code or "Not found"]\nReference: [ids comma-separated or "Not found"]';
        var r = this.invoke(prompt, model);
        if (!r.success) { return { success: false, error: r.error, currency: 'Error', reference: 'Error', fullResponse: '' }; }
        var t = r.response || '';
        var cm = t.match(/Currency:\s*([A-Z]{3}|Not found)/i);
        var rm = t.match(/Reference:\s*(.+?)(?:\n|$)/i);
        return { success: true, currency: cm ? cm[1] : 'Not found', reference: rm ? rm[1].trim() : 'Not found',
                 fullResponse: t, responseTimeMs: r.responseTimeMs };
    },

    type: 'ChinouClient'
};
