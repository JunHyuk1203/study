// Micro-won integers avoid rounding down tiny token charges. Full post-promotion
// standard prices are deliberately used even while introductory discounts apply.
export const MONTHLY_LIMIT = 1000 * 1e6;
export const MODELS = Object.freeze({
  'gemini-3.8-flash': {name:'Gemini 3.8 Flash', input:1.5, output:7.5},
  'gemini-4-argon': {name:'Gemini 4 Argon', input:4, output:20},
});
export function tokenCost(model, input, output, exchangeRate) {
  const price = MODELS[model];
  if (!price || !Number.isFinite(exchangeRate) || exchangeRate < 1 || ![input,output].every(v=>Number.isSafeInteger(v)&&v>=0)) throw new Error('invalid-cost');
  return Math.ceil((input*price.input + output*price.output) * exchangeRate);
}
export function allowance({model, inputTokens, spent = 0, reserved = 0, exchangeRate, requested = 2048}) {
  if (!MODELS[model] || ![spent,reserved,requested].every(v=>Number.isSafeInteger(v)&&v>=0)) throw new Error('invalid-budget');
  // Include system/serialization overhead and keep a margin over countTokens.
  const inputBound = Math.ceil(inputTokens * 11 / 10) + 256;
  const remaining = MONTHLY_LIMIT - spent - reserved;
  const inputCost = tokenCost(model,inputBound,0,exchangeRate);
  const output = Math.max(0,Math.min(requested,Math.floor((remaining-inputCost)/(MODELS[model].output*exchangeRate))));
  if (output < 64) throw new Error('monthly-limit');
  const amount = tokenCost(model,inputBound,output,exchangeRate);
  if (amount > remaining) throw new Error('monthly-limit');
  return {inputBound,output,amount,limited:output<requested};
}
export function parseExchangeRate(xml) {
  const usd=Number(xml.match(/currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/)?.[1]);
  const krw=Number(xml.match(/currency=['"]KRW['"]\s+rate=['"]([\d.]+)['"]/)?.[1]);
  if (!(usd>0&&krw>0)) throw new Error('invalid-exchange-rate');
  // Include VAT and a 20% currency margin, with a conservative 2,000 KRW floor.
  return Math.ceil(Math.max(2000,krw/usd)*1.1*1.2);
}
