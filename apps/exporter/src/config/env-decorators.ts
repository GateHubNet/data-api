import { Transform } from 'class-transformer';
import { IsString, registerDecorator, ValidateIf, ValidationArguments } from 'class-validator';

/**
 * Decorators for a config class read by the toolbox ConfigService (`@ConfigValue()`, `GH_*` variables).
 *
 * The toolbox pipeline cannot express an optional or defaulted value on its own: an unset variable overwrites a class
 * initializer with `undefined`, `@ConfigValue()` makes every value required, and the implicit conversion turns a blank
 * into `0` and the string "false" into `true`. These decorators read the raw variable instead, take the default from
 * the property initializer of the class, parse numbers strictly, and name the environment variable in their messages.
 */

/** `liveCacheTtlMs` -> `GH_LIVE_CACHE_TTL_MS`: the name the ConfigService reads. */
export function envName(property: string): string {
  return `GH_${property.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** The raw string behind `obj[key]`, trimmed; `undefined` when the variable is unset or blank. */
export function rawValue(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Separates a comma list the same way everywhere (node endpoints, API keys, CORS origins). */
export function splitList(csv: string): string[] {
  return csv
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** The initializers of the config class `target` belongs to, read from a throw-away instance on first use. */
function defaultsOf(target: object): (key: string) => unknown {
  let defaults: Record<string, unknown> | undefined;
  return (key) => (defaults ??= new (target.constructor as new () => Record<string, unknown>)())[key];
}

/** A class-validator decorator whose message names the environment variable instead of the property. */
export function validator(
  name: string,
  validate: (value: unknown) => boolean,
  describe: (variable: string, args: ValidationArguments) => string,
): () => PropertyDecorator {
  return () => (target, propertyKey) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate,
        defaultMessage: (args: ValidationArguments) => describe(envName(args.property), args),
      },
    });
}

/** A non-blank string; unset or blank takes the initializer. */
export function Text(): PropertyDecorator {
  return (target, key) =>
    Transform(({ obj }) => rawValue(obj, key as string) ?? defaultsOf(target)(key as string))(target, key);
}

/**
 * A string that may be empty (`GH_API_KEYS=`): an unset variable takes the initializer, a set one is used as it is
 * (trimmed), and an empty value skips the other validators of the property.
 */
export function MaybeEmptyText(): PropertyDecorator {
  return (target, key) => {
    Transform(({ obj }) => {
      const value = obj[key as string];
      return typeof value === 'string' ? value.trim() : defaultsOf(target)(key as string);
    })(target, key);
    ValidateIf((config: Record<string, unknown>) => config[key as string] !== '')(target, key);
    IsString()(target, key);
  };
}

/** An integer between `min` and `max`, read as plain decimal digits (so `1.5`, `1e3` and `abc` are invalid). */
export function IntValue(options: { min: number; max?: number }): PropertyDecorator {
  const { min, max } = options;
  const range =
    max !== undefined
      ? `an integer between ${min} and ${max}`
      : min === 1
        ? 'a positive integer'
        : 'a non-negative integer';
  const check = validator(
    'isConfigInteger',
    (value) =>
      Number.isSafeInteger(value) && (value as number) >= min && (max === undefined || (value as number) <= max),
    (variable) => `${variable} must be ${range}`,
  )();
  return (target, key) => {
    Transform(({ obj }) => {
      const raw = rawValue(obj, key as string);
      if (raw === undefined) return defaultsOf(target)(key as string);
      return /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    })(target, key);
    check(target, key);
  };
}
