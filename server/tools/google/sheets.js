import { registerTool } from "../registry.js";
import * as sheets from "../../integrations/google/sheets/api.js";

registerTool({
  name: "sheets.create_spreadsheet",
  description: "Creates a new Google Sheets spreadsheet, optionally with named tabs.",
  category: "sheets",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, sheetNames: { type: "array", items: { type: "string" } } },
    required: ["title"],
  },
  requiredPermissions: ["sheets.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return sheets.createSpreadsheet(context.userId, parameters.title, parameters.sheetNames);
  },
});

registerTool({
  name: "sheets.list_tabs",
  description: "Lists the tabs (sheets) inside a spreadsheet.",
  category: "sheets",
  parameters: { type: "object", properties: { spreadsheetId: { type: "string" } }, required: ["spreadsheetId"] },
  requiredPermissions: ["sheets.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    return sheets.listSheetTabs(context.userId, parameters.spreadsheetId);
  },
});

registerTool({
  name: "sheets.read_range",
  description: "Reads cell values from a range, e.g. 'Sheet1!A1:D20'.",
  category: "sheets",
  parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" } }, required: ["spreadsheetId", "range"] },
  requiredPermissions: ["sheets.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    return sheets.readRange(context.userId, parameters.spreadsheetId, parameters.range);
  },
});

registerTool({
  name: "sheets.write_range",
  description: "Writes cell values into a range, overwriting whatever is there. values is a 2D array — rows of cell values.",
  category: "sheets",
  parameters: {
    type: "object",
    properties: {
      spreadsheetId: { type: "string" },
      range: { type: "string" },
      values: { type: "array", items: { type: "array" } },
    },
    required: ["spreadsheetId", "range", "values"],
  },
  requiredPermissions: ["sheets.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return sheets.writeRange(context.userId, parameters.spreadsheetId, parameters.range, parameters.values);
  },
});

registerTool({
  name: "sheets.append_row",
  description: "Appends a single new row to the end of existing data in a sheet/range.",
  category: "sheets",
  parameters: {
    type: "object",
    properties: {
      spreadsheetId: { type: "string" },
      range: { type: "string", description: "e.g. 'Sheet1' or 'Sheet1!A:D'" },
      values: { type: "array", items: {}, description: "One row's values, e.g. ['2026-08-01', 'Widget', 25]" },
    },
    required: ["spreadsheetId", "range", "values"],
  },
  requiredPermissions: ["sheets.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return sheets.appendRow(context.userId, parameters.spreadsheetId, parameters.range, parameters.values);
  },
});
