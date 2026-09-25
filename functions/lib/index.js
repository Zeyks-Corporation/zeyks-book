"use strict";
/**
 * Zeyks Book — Cloud Functions entrypoint.
 *
 * Every export becomes a callable endpoint. Grouped by concern:
 *   auth.ts     — requestOtp / verifyOtp (passwordless email sign-in)
 *   posting.ts  — postJournal / voidDocument / seedChartIfEmpty (the ledger)
 *   business.ts — createBusiness / updateBusiness (tenant lifecycle)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateBusiness = exports.createBusiness = exports.closeFiscalYear = exports.seedChartIfEmpty = exports.voidDocument = exports.postJournal = exports.verifyOtp = exports.requestOtp = void 0;
var auth_1 = require("./auth");
Object.defineProperty(exports, "requestOtp", { enumerable: true, get: function () { return auth_1.requestOtp; } });
Object.defineProperty(exports, "verifyOtp", { enumerable: true, get: function () { return auth_1.verifyOtp; } });
var posting_1 = require("./posting");
Object.defineProperty(exports, "postJournal", { enumerable: true, get: function () { return posting_1.postJournal; } });
Object.defineProperty(exports, "voidDocument", { enumerable: true, get: function () { return posting_1.voidDocument; } });
Object.defineProperty(exports, "seedChartIfEmpty", { enumerable: true, get: function () { return posting_1.seedChartIfEmpty; } });
Object.defineProperty(exports, "closeFiscalYear", { enumerable: true, get: function () { return posting_1.closeFiscalYear; } });
var business_1 = require("./business");
Object.defineProperty(exports, "createBusiness", { enumerable: true, get: function () { return business_1.createBusiness; } });
Object.defineProperty(exports, "updateBusiness", { enumerable: true, get: function () { return business_1.updateBusiness; } });
//# sourceMappingURL=index.js.map