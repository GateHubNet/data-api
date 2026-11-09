import Ajv, { ValidateFunction } from 'ajv';

/** One Ajv of every test, strict: an unknown keyword in a schema is an error of the schema, not ignored. */
const ajv = new Ajv({ allErrors: true, strict: true });
const compiled = new WeakMap<object, ValidateFunction>();

function validatorOf(schema: object): ValidateFunction {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/** The errors of `body` against `schema`, as `<path> <message>` lines; none when it validates. */
export function schemaErrors(body: unknown, schema: object): string[] {
  const validate = validatorOf(schema);
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

/** Fails the test with the errors when `body` does not validate against `schema`. */
export function expectSchema(body: unknown, schema: object): void {
  const errors = schemaErrors(body, schema);
  if (errors.length > 0) throw new Error(`the answer does not validate:\n${errors.join('\n')}`);
}
