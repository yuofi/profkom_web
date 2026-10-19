/** Test-only validation of actual JSON against declared public TypeScript DTOs. */
import ts from "typescript";
import { fileURLToPath } from "node:url";

const paths = ["../utils/api/contract.ts", "../utils/api/types.ts"].map(p => fileURLToPath(new URL(p, import.meta.url)));
const program = ts.createProgram(paths, { strict: true, target: ts.ScriptTarget.ESNext });
const checker = program.getTypeChecker();
const sources = paths.map(p => program.getSourceFile(p)!);

export function wireIssues(name: string, value: unknown): string[] {
  const symbol = sources.flatMap(s => checker.getExportsOfModule(checker.getSymbolAtLocation(s)!)).find(s => s.name === name);
  if (!symbol) throw Error(`Unknown DTO ${name}`);
  return validate(checker.getDeclaredTypeOfSymbol(symbol), value, name);
}

function validate(type: ts.Type, value: unknown, path: string, depth = 0): string[] {
  if (depth > 20) throw Error(`DTO recursion limit at ${path}`);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return [];
  if (type.isUnion()) {
    const results = type.types.map(t => validate(t, value, path, depth + 1));
    return results.some(r => !r.length) ? [] : [`${path}: expected ${checker.typeToString(type)}`];
  }
  if (type.flags & ts.TypeFlags.Null) return value === null ? [] : [`${path}: expected null`];
  if (type.flags & ts.TypeFlags.Undefined) return value === undefined ? [] : [`${path}: expected undefined`];
  if (type.isLiteral()) return value === type.value ? [] : [`${path}: expected ${String(type.value)}`];
  for (const [flag, primitive] of [[ts.TypeFlags.StringLike, "string"], [ts.TypeFlags.NumberLike, "number"], [ts.TypeFlags.BooleanLike, "boolean"]] as const)
    if (type.flags & flag) return typeof value === primitive ? [] : [`${path}: expected ${primitive}`];
  if (checker.isArrayType(type)) return Array.isArray(value)
    ? value.flatMap((v, i) => validate(checker.getTypeArguments(type as ts.TypeReference)[0], v, `${path}[${i}]`, depth + 1))
    : [`${path}: expected array`];
  if (!value || typeof value !== "object") return [`${path}: expected object`];
  return checker.getPropertiesOfType(type).flatMap(p => {
    const field = (value as Record<string, unknown>)[p.name];
    if (field === undefined && p.flags & ts.SymbolFlags.Optional) return [];
    return validate(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations![0]), field, `${path}.${p.name}`, depth + 1);
  });
}
