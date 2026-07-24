import { z } from "zod";

export const nameMatchSchema = z.enum(["exact", "ilike", "regex"]);

export const nameFilterFields = {
  name: z.string().trim().min(1).max(160).optional(),
  nameMatch: nameMatchSchema.default("ilike")
};

export type NameFilter = {
  name?: string | undefined;
  nameMatch: z.infer<typeof nameMatchSchema>;
};

export function validateNameFilter(filter: NameFilter, context: z.RefinementCtx): void {
  if (!filter.name || filter.nameMatch !== "regex") return;
  try {
    new RegExp(filter.name, "i");
  } catch {
    context.addIssue({ code: "custom", path: ["name"], message: "Name is not a valid regular expression" });
  }
}

export function appendNameFilter(
  conditions: string[],
  values: unknown[],
  column: string,
  filter: NameFilter
): void {
  if (!filter.name) return;
  const value = filter.nameMatch === "ilike" ? `%${filter.name}%` : filter.name;
  values.push(value);
  const parameter = `$${values.length}`;
  if (filter.nameMatch === "exact") conditions.push(`lower(${column}) = lower(${parameter})`);
  else if (filter.nameMatch === "regex") conditions.push(`${column} ~* ${parameter}`);
  else conditions.push(`${column} ILIKE ${parameter}`);
}
