import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckError } from './types.ts';

// The JSON Schema subset Cura's own schemas use; anything else is ignored.
interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

export type SchemaName = 'config' | 'plan' | 'candidate' | 'review';

export function loadSchema(name: SchemaName): object {
  const file = join(import.meta.dirname, '..', 'schemas', `${name}.schema.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as object;
}

export function validate(schema: object, value: unknown, path = ''): CheckError[] {
  const errors: CheckError[] = [];
  visit(schema as SchemaNode, value, path, errors);
  return errors;
}

function visit(schema: SchemaNode, value: unknown, path: string, errors: CheckError[]): void {
  const at = path || '/';
  const fail = (code: string, detail: string) => errors.push({ code, message: `${at}: ${detail}`, path: at });

  if (schema.type && !hasType(value, schema.type)) {
    fail('schema.type', `expected ${schema.type}, got ${describeType(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail('schema.enum', `${JSON.stringify(value)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('schema.min', `${value} is below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail('schema.max', `${value} is above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail('schema.min', `expected at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.items) value.forEach((item, i) => visit(schema.items!, item, `${path}/${i}`, errors));
    return;
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail('schema.required', `missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      const childPath = `${path}/${escapePointer(key)}`;
      if (childSchema) visit(childSchema, child, childPath, errors);
      else if (schema.additionalProperties === false) {
        errors.push({ code: 'schema.additional', message: `${childPath}: unexpected property "${key}"`, path: childPath });
      }
    }
  }
}

function hasType(value: unknown, type: NonNullable<SchemaNode['type']>): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return typeof value === type;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
