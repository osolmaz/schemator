import { extname } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { readText } from "../files.js";
import { fencedCodeBlocks } from "../markdown.js";
import type { ModelGraph, ModelNode, SourceSpan } from "../types.js";
import { extractJsonSchemaModel } from "./json-schema.js";
import { extractObjectModel, modelIdForObject } from "./object.js";
import { extractSqlModels } from "./sql.js";
import { collectTypeScriptObjectModelNames, extractTypeScriptModels } from "./typescript.js";

type JsonSourceFileWithDiagnostics = ts.JsonSourceFile & {
  parseDiagnostics: readonly ts.Diagnostic[];
};

const invalidJsoncValue = Symbol("schemator.invalidJsoncValue");

type JsoncValue = null | string | number | boolean | JsoncValue[] | { [key: string]: JsoncValue };
type JsoncExpressionValue = JsoncValue | typeof invalidJsoncValue;

export async function extractGraph(sourcePath: string): Promise<ModelGraph> {
  const text = await readText(sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  const source: SourceSpan = {
    path: sourcePath,
    span: {
      startLine: 1,
      endLine: text.split(/\r?\n/).length,
    },
  };
  const models =
    extension === ".md"
      ? extractMarkdownModels(text, sourcePath)
      : extractDirectModels(text, sourcePath, extension, source);

  return {
    schemaVersion: 1,
    source: {
      path: sourcePath,
      revision: null,
    },
    models: dedupeModels(models),
  };
}

function extractDirectModels(
  text: string,
  sourcePath: string,
  extension: string,
  source: SourceSpan,
): ModelNode[] {
  if (isTypeScriptExtension(extension)) {
    return mergeDuplicateTypeScriptModels(extractTypeScriptModels(text, sourcePath, 1));
  }
  if (extension === ".json") {
    const parsed = JSON.parse(text) as unknown;
    return [jsonLikeToModel(parsed, "JsonSchema", source)];
  }
  if (extension === ".yaml" || extension === ".yml") {
    const parsed = parseYaml(text) as unknown;
    return [jsonLikeToModel(parsed, "YamlDocument", source)];
  }
  if (extension === ".sql") {
    return extractSqlModels(text, sourcePath);
  }
  return [];
}

function isTypeScriptExtension(extension: string): boolean {
  return extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts";
}

function extractMarkdownModels(text: string, sourcePath: string): ModelNode[] {
  const models: ModelNode[] = [];
  let jsonIndex = 0;
  let yamlIndex = 0;
  const blocks = fencedCodeBlocks(text);
  const markdownTypeScriptModelNames = new Set<string>();
  for (const block of blocks) {
    if (block.language === "ts" || block.language === "typescript") {
      for (const modelName of collectTypeScriptObjectModelNames(block.code, sourcePath)) {
        markdownTypeScriptModelNames.add(modelName);
      }
    }
  }
  for (const block of blocks) {
    const source: SourceSpan = {
      path: sourcePath,
      span: {
        startLine: block.startLine,
        endLine: block.endLine,
      },
    };
    if (block.language === "ts" || block.language === "typescript") {
      models.push(
        ...mergeDuplicateTypeScriptModels(
          extractTypeScriptModels(block.code, sourcePath, block.startLine, markdownTypeScriptModelNames),
        ),
      );
      continue;
    }
    if (block.language === "json" || block.language === "jsonc") {
      const parsed = block.language === "jsonc" ? parseJsoncLike(block.code) : parseJsonLike(block.code);
      if (parsed !== null) {
        jsonIndex += 1;
        models.push(jsonLikeToModel(parsed, `JsonBlock${jsonIndex}`, source));
      }
      continue;
    }
    if (block.language === "yaml" || block.language === "yml") {
      const parsed = parseYaml(block.code) as unknown;
      yamlIndex += 1;
      models.push(jsonLikeToModel(parsed, `YamlBlock${yamlIndex}`, source));
      continue;
    }
    if (block.language === "sql") {
      models.push(...extractSqlModels(block.code, sourcePath, block.startLine));
    }
  }
  return models.filter((model) => model.fields.length > 0);
}

function jsonLikeToModel(value: unknown, fallbackId: string, source: SourceSpan): ModelNode {
  if (isJsonSchema(value)) {
    const title = value["title"];
    const modelId = typeof title === "string" && title.trim() ? title : fallbackId;
    return extractJsonSchemaModel(value, modelId, source);
  }
  return extractObjectModel(value, modelIdForObject(value, fallbackId), source);
}

function parseJsonLike(code: string): unknown | null {
  try {
    return JSON.parse(code) as unknown;
  } catch {
    return null;
  }
}

function parseJsoncLike(code: string): unknown | null {
  const parsed = ts.parseJsonText("schema.jsonc", code);
  if ((parsed as JsonSourceFileWithDiagnostics).parseDiagnostics.length > 0) {
    return null;
  }
  const statement = parsed.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    return null;
  }
  const value = jsoncExpressionValue(statement.expression);
  return value === invalidJsoncValue ? null : value;
}

function jsoncExpressionValue(expression: ts.Expression): JsoncExpressionValue {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken) {
    const operand = jsoncExpressionValue(expression.operand);
    return typeof operand === "number" ? -operand : invalidJsoncValue;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const array: JsoncValue[] = [];
    for (const element of expression.elements) {
      const value = jsoncExpressionValue(element);
      if (value === invalidJsoncValue) {
        return invalidJsoncValue;
      }
      array.push(value);
    }
    return array;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const object: Record<string, JsoncValue> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return invalidJsoncValue;
      }
      const name = jsoncPropertyName(property.name);
      if (name === null) {
        return invalidJsoncValue;
      }
      const value = jsoncExpressionValue(property.initializer);
      if (value === invalidJsoncValue) {
        return invalidJsoncValue;
      }
      object[name] = value;
    }
    return object;
  }
  return invalidJsoncValue;
}

function jsoncPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function mergeDuplicateTypeScriptModels(models: ModelNode[]): ModelNode[] {
  const mergedById = new Map<string, ModelNode>();
  const merged: ModelNode[] = [];
  for (const model of models) {
    const existing = mergedById.get(model.id);
    if (!existing) {
      const copy = {
        ...model,
        fields: model.fields.map((field) => ({ ...field })),
      };
      mergedById.set(model.id, copy);
      merged.push(copy);
      continue;
    }
    existing.kind = existing.kind === model.kind ? existing.kind : "object";
    for (const field of model.fields) {
      mergeField(existing.fields, {
        ...field,
        parent: existing.id,
      });
    }
  }
  return merged;
}

function mergeField(fields: ModelNode["fields"], field: ModelNode["fields"][number]): void {
  const existing = fields.find((candidate) => candidate.path === field.path);
  if (!existing) {
    fields.push(field);
    return;
  }
  existing.type = uniqueTypeParts([...existing.type.split(" & "), ...field.type.split(" & ")]).join(" & ");
  existing.required = existing.required || field.required;
  existing.nullable = existing.nullable || field.nullable;
  existing.objectLike = existing.objectLike || field.objectLike;
  if (!existing.ref && field.ref) {
    existing.ref = field.ref;
  }
}

function uniqueTypeParts(parts: string[]): string[] {
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const hasSchemaMetadata = typeof value["$schema"] === "string" || typeof value["$id"] === "string";
  const hasAdditionalPropertiesApplicator =
    typeof value["additionalProperties"] === "boolean" || isSchemaProperty(value["additionalProperties"]);
  const hasItemsApplicator =
    isSchemaProperty(value["items"]) || (Array.isArray(value["items"]) && value["items"].some(isSchemaProperty));
  const hasRootSchemaKeyword =
    typeof value["$ref"] === "string" ||
    isSchemaType(value["type"]) ||
    isRecord(value["$defs"]) ||
    isRecord(value["definitions"]) ||
    isRecord(value["patternProperties"]) ||
    hasAdditionalPropertiesApplicator ||
    hasItemsApplicator ||
    Array.isArray(value["prefixItems"]) ||
    Array.isArray(value["allOf"]) ||
    Array.isArray(value["anyOf"]) ||
    Array.isArray(value["oneOf"]);
  const hasSchemaShape =
    hasRootSchemaKeyword ||
    isRecord(value["properties"]) ||
    isRecord(value["patternProperties"]) ||
    "additionalProperties" in value ||
    "prefixItems" in value ||
    "items" in value;
  const hasOnlySchemaRootKeys = Object.keys(value).every(isSchemaRootKey);
  return (
    (hasSchemaMetadata && hasSchemaShape) ||
    (hasOnlySchemaRootKeys &&
      (hasRootSchemaKeyword || hasSchemaProperties(value["properties"]) || hasSchemaProperties(value["patternProperties"])))
  );
}

function isSchemaRootKey(key: string): boolean {
  return schemaRootKeys.has(key);
}

const schemaRootKeys = new Set([
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "default",
  "definitions",
  "description",
  "enum",
  "examples",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "required",
  "title",
  "type",
]);

function hasSchemaProperties(value: unknown): boolean {
  return isRecord(value) && Object.values(value).some(isSchemaProperty);
}

function isSchemaProperty(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["$ref"] === "string" ||
    isSchemaType(value["type"]) ||
    isRecord(value["properties"]) ||
    isRecord(value["patternProperties"]) ||
    Array.isArray(value["prefixItems"]) ||
    Array.isArray(value["allOf"]) ||
    Array.isArray(value["anyOf"]) ||
    Array.isArray(value["oneOf"]) ||
    "items" in value
  );
}

function isSchemaType(value: unknown): boolean {
  const knownTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  if (typeof value === "string") {
    return knownTypes.has(value);
  }
  return Array.isArray(value) && value.some((item) => typeof item === "string" && knownTypes.has(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeModels(models: ModelNode[]): ModelNode[] {
  const seen = new Map<string, number>();
  const plans: ModelDedupePlan[] = models.map((model) => {
    const occurrence = (seen.get(model.id) ?? 0) + 1;
    seen.set(model.id, occurrence);
    return {
      model,
      baseId: model.id,
      occurrence,
      dedupedId: occurrence === 1 ? model.id : `${model.id}#${occurrence}`,
    };
  });
  const plansByBase = new Map<string, ModelDedupePlan[]>();
  for (const plan of plans) {
    const basePlans = plansByBase.get(plan.baseId) ?? [];
    basePlans.push(plan);
    plansByBase.set(plan.baseId, basePlans);
  }
  return plans.map((plan) => ({
    ...plan.model,
    id: plan.dedupedId,
    fields: plan.model.fields.map((field) => {
      const ref = field.ref ? dedupedRef(field.ref, plan, plansByBase) : undefined;
      return {
        ...field,
        parent: plan.dedupedId,
        ...(ref ? { ref } : {}),
      };
    }),
  }));
}

type ModelDedupePlan = {
  model: ModelNode;
  baseId: string;
  occurrence: number;
  dedupedId: string;
};

function dedupedRef(
  ref: string,
  referringPlan: ModelDedupePlan,
  plansByBase: Map<string, ModelDedupePlan[]>,
): string {
  const candidates = plansByBase.get(ref);
  if (!candidates) {
    return ref;
  }
  if (ref === referringPlan.baseId) {
    return referringPlan.dedupedId;
  }
  const sameSource = candidates.filter((candidate) => candidate.model.source.path === referringPlan.model.source.path);
  const beforeOrAt = sameSource
    .filter((candidate) => candidate.model.source.span.startLine <= referringPlan.model.source.span.startLine)
    .sort((left, right) => right.model.source.span.startLine - left.model.source.span.startLine);
  const nearestBefore = beforeOrAt[0];
  if (nearestBefore) {
    return nearestBefore.dedupedId;
  }
  const nearestAfter = sameSource.sort((left, right) =>
    left.model.source.span.startLine - right.model.source.span.startLine
  )[0];
  if (nearestAfter) {
    return nearestAfter.dedupedId;
  }
  return candidates[Math.min(referringPlan.occurrence - 1, candidates.length - 1)]?.dedupedId ?? ref;
}
