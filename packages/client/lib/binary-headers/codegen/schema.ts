export type Endianness = 'big' | 'little';

export type PrimitiveType = 'uint8' | 'uint16' | 'uint32' | 'int8' | 'int16' | 'int32';

export interface Bitfield {
  readonly name: string;
  readonly bits: number;
  readonly mask: number;
}

export interface Validation {
  readonly min?: number;
  readonly max?: number;
}

export interface FixedField {
  readonly kind: 'fixed';
  readonly name: string;
  readonly type: PrimitiveType;
  readonly offset: number;
  readonly endian?: Endianness;
  readonly value: number;
}

export interface VariableField {
  readonly kind: 'variable';
  readonly name: string;
  readonly type: PrimitiveType;
  readonly offset: number;
  readonly endian?: Endianness;
  readonly validation?: Validation;
}

export interface BitfieldGroup {
  readonly kind: 'bitfield';
  readonly name: string;
  readonly offset: number;
  readonly fields: ReadonlyArray<Bitfield>;
}

export interface Padding {
  readonly kind: 'padding';
  readonly offset: number;
  readonly size: number;
}

export type Field = FixedField | VariableField | BitfieldGroup | Padding;

export interface Constant {
  readonly name: string;
  readonly value: number;
  readonly description?: string;
}

export interface MessageSchema {
  readonly name: string;
  readonly size: number;
  readonly description?: string;
  readonly fields: ReadonlyArray<Field>;
}

export interface ProtocolSchema {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly constants: ReadonlyArray<Constant>;
  readonly messages: ReadonlyArray<MessageSchema>;
}

export function field(name: string, type: PrimitiveType, offset: number, options?: {
  endian?: Endianness;
  min?: number;
  max?: number;
}): VariableField {
  const { endian, min, max } = options ?? {};
  const validation = buildValidation(min, max);
  return { kind: 'variable', name, type, offset, endian, validation };
}

function buildValidation(min: number | undefined, max: number | undefined): { min?: number; max?: number } | undefined {
  if (min === undefined && max === undefined) return undefined;
  const result: { min?: number; max?: number } = {};
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;
  return result;
}

export function fixed(name: string, type: PrimitiveType, offset: number, value: number, options?: {
  endian?: Endianness;
}): FixedField {
  return { kind: 'fixed', name, type, offset, value, ...options };
}

export function bitfield(name: string, offset: number, fields: ReadonlyArray<Bitfield>): BitfieldGroup {
  return { kind: 'bitfield', name, offset, fields };
}

export function padding(offset: number, size: number): Padding {
  return { kind: 'padding', offset, size };
}

export function constant(name: string, value: number, description?: string): Constant {
  return { name, value, description };
}

export function message(name: string, size: number, fields: ReadonlyArray<Field>, description?: string): MessageSchema {
  return { name, size, fields, description };
}

export function protocol(
  name: string,
  version: number,
  constants: ReadonlyArray<Constant>,
  messages: ReadonlyArray<MessageSchema>,
  description?: string
): ProtocolSchema {
  return { name, version, constants, messages, description };
}
