// Future public/live Care Plan intake. Classification is server-controlled.
import { handleCarePlanMethod, handleCarePlanOptions, handleCarePlanRequest } from "../../lib/intake/handle-request.js";
export function onRequestOptions(context) { return handleCarePlanOptions(context); }
export function onRequestPost(context) { return handleCarePlanRequest(context, { isTest: false }); }
export function onRequest(context) { return handleCarePlanMethod(context); }
