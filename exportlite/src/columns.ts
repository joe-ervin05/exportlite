import { ExportLiteError } from "./errors.js";

/** A read-only declaration; never creates a column or changes its constraints. */
export class Column<T, Required extends boolean = false> {
  declare readonly _: T;

  constructor(
    readonly name: string | undefined,
    readonly kind: "value" | "boolean",
    readonly required: Required,
    readonly dataType: "text" | "integer" | "real",
    readonly primary = false,
  ) {
    if (
      name !== undefined &&
      (typeof name !== "string" || !name || name.includes("\0"))
    )
      throw new ExportLiteError("INVALID_SCHEMA", "Invalid column name.");
    Object.freeze(this);
  }

  notNull(): Column<T, true> {
    return new Column(this.name, this.kind, true, this.dataType, this.primary);
  }

  /** Declares an existing unique, non-null key; never changes the database. */
  primaryKey(): Column<T, true> {
    return new Column(this.name, this.kind, true, this.dataType, true);
  }
}

export type SelectedColumns = Readonly<
  Record<string, Column<unknown, boolean>>
>;
export type InferColumns<C extends SelectedColumns> = {
  -readonly [K in keyof C]: C[K] extends Column<infer T, infer Required>
    ? Required extends true
      ? T
      : T | null
    : never;
};

/** A text value; nullable unless .notNull() is specified. */
export function text(name?: string): Column<string> {
  return new Column(name, "value", false, "text");
}

/** A floating-point value; nullable unless .notNull() is specified. */
export function real(name?: string): Column<number> {
  return new Column(name, "value", false, "real");
}

/** Integer values, or SQLite 0/1 values encoded as JSON booleans. */
export function integer<M extends "number" | "boolean" = "number">(
  nameOrOptions?: string | { mode: M },
  options?: { mode: M },
): Column<M extends "boolean" ? boolean : number> {
  if (
    nameOrOptions !== undefined &&
    typeof nameOrOptions !== "string" &&
    (!nameOrOptions || typeof nameOrOptions !== "object")
  )
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "Invalid integer declaration.",
    );
  const name = typeof nameOrOptions === "string" ? nameOrOptions : undefined;
  const mode =
    (typeof nameOrOptions === "object" ? nameOrOptions : options)?.mode ??
    "number";
  if (mode !== "number" && mode !== "boolean")
    throw new ExportLiteError(
      "INVALID_OPTIONS",
      "integer mode must be number or boolean.",
    );
  return new Column(
    name,
    mode === "boolean" ? "boolean" : "value",
    false,
    "integer",
  );
}
