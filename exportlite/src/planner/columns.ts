import { Column, type SelectedColumns } from "../columns.js";
import { ExportLiteError } from "../errors.js";
import { identifier, literal, uniqueColumns } from "./identifiers.js";

export interface SelectedField {
  key: string;
  column: string;
  kind: "value" | "boolean";
  dataType: "text" | "integer" | "real";
  primary: boolean;
}

export function selectedFields(columns: SelectedColumns): SelectedField[] {
  if (
    !columns ||
    typeof columns !== "object" ||
    Array.isArray(columns) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(columns))
  )
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "columns must be an object containing ExportLite column declarations.",
    );
  const fields = Object.entries(columns).map(([key, declaration]) => {
    if (!(declaration instanceof Column))
      throw new ExportLiteError(
        "INVALID_OPTIONS",
        "Use text(), integer() or real() to declare selected columns.",
      );
    const column = declaration.name ?? key;
    identifier(column);
    return {
      key,
      column,
      kind: declaration.kind,
      dataType: declaration.dataType,
      primary: declaration.primary,
    };
  });
  uniqueColumns(fields.map((field) => field.key));
  return fields;
}

export function selectedObject(
  fields: readonly SelectedField[],
  reference: (field: SelectedField, index: number) => string,
): string {
  const pairs = fields.map((field, index) => {
    const value = reference(field, index);
    // Keep booleans native JSON. Reject values outside the declared SQLite 0/1
    // representation instead of silently treating arbitrary values as truthy.
    const jsonValue =
      field.kind === "boolean"
        ? `json(CASE ${value} WHEN 0 THEN 'false' WHEN 1 THEN 'true' ELSE CASE WHEN ${value} IS NULL THEN NULL ELSE 'ExportLite: expected boolean 0 or 1' END END)`
        : value;
    return `${literal(field.key)}, ${jsonValue}`;
  });
  return `json_object(${pairs.join(", ")})`;
}
