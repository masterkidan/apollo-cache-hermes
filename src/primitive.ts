/**
 * @fileoverview
 *
 * We rely on a few generic types that aren't included by default in TypeScript.
 */

/**
 * A primitive value.
 */
export type scalar = undefined | null | boolean | number | string | Symbol;

/**
 * A missing object.
 */
export type nil = undefined | null;

/**
 * A component of a path through objects/arrays.
 */
export type PathPart = number | string;

/**
 * A JavaScript constructor.
 */
export interface Constructor<TClass extends object> {
  new(...args: any[]): TClass;
  prototype: TClass;
}

/**
 * A partial object, applied recursively.
 */
export type DeepPartial<TType> = {
  [Key in keyof TType]?: DeepPartial<TType[Key]>
};

/**
 * A readonly object, applied recursively.
 */
// Paste the following code into http://www.typescriptlang.org/play/index.html and check how if the relevant test cases fail
  // https://gist.github.com/khoomeister/2ec82bab9a5188d03766bf090e1f1150 <- This gist has all the test cases.

  // List all primitive types that are readonly by default, as they are immutable
  export type Primitive = string | number | boolean | undefined | null | symbol;

  // Test if type is of a certain type, and accordingly deep cast.
  export type DeepReadonly<T> =
  T extends DeepReadonlyObject<infer A>                                     ? T :
  T extends DeepReadonlyArray<infer A>                                      ? T :
  T extends IterableIterator<infer A>                                       ? IterableIterator<DeepReadonlyObject<A>> :
  T extends [infer A]                                                       ? DeepReadonlyObject<[A]> : // This is for special arrays (array must have single element)
  T extends [infer A, infer B]                                              ? DeepReadonlyObject<[A, B]> : // This is for special arrays (array must have 2 elements, 2 types)
  T extends [infer A, infer B, infer C]                                     ? DeepReadonlyObject<[A, B, C]> : // This is for special arrays (array must have 3 elements, 3 types)
  T extends [infer A, infer B, infer C, infer D]                            ? DeepReadonlyObject<[A, B, C, D]> : // This is for special arrays (array must have 4 elements, 4 types)
  T extends [infer A, infer B, infer C, infer D, infer E]                   ? DeepReadonlyObject<[A, B, C, D, E]> : // This is for special arrays (array must have 5 elements, 5 types)
  T extends [infer A, infer B, infer C, infer D, infer E, infer F]          ? DeepReadonlyObject<[A, B, C, D, E, F]> : // This is for special arrays (array must have 6 elements, 6 types)
  T extends [infer A, infer B, infer C, infer D, infer E, infer F, infer G] ? DeepReadonlyObject<[A, B, C, D, E, F, G]> : // This is for special arrays (array must have 7 elements, 7 types)
  T extends Map<infer U, infer V>                                           ? ReadonlyMap<DeepReadonlyObject<U>, DeepReadonlyObject<V>> : // Readonly for maps
  T extends Set<infer U>                                                    ? ReadonlySet<DeepReadonlyObject<U>> : // Readonly for
  T extends Promise<infer U>                                                ? Promise<DeepReadonlyObject<U>> : // For promises
  T extends Function                                                        ? T : // For functions
  T extends Primitive                                                       ? T : // For primitives
  T extends (infer A)[]                                                     ? DeepReadonlyArray<A> : // For arrays
  DeepReadonlyObject<T>; // For objects

  // Extend the ReedonlyArray to cast recursively cast array and array items as readonly.
  export interface DeepReadonlyArray<T> extends ReadonlyArray<DeepReadonly<T>> {}

  // Iterate through public properties of the array and cast them as readonly.
  export type DeepReadonlyObject<T> = { readonly [P in keyof T]: DeepReadonly<T[P]> };

  

/**
 * Represents a complex object that can contain values of a specific type,
 * that can be rooted within objects/arrays of arbitrary depth.
 */
export type NestedValue<TValue> = TValue | NestedArray<TValue> | NestedObject<TValue>;
export interface NestedArray<TValue> extends Array<NestedValue<TValue>> {}
export interface NestedObject<TValue> { [key: string]: NestedValue<TValue>; }

// JSON

export type JsonScalar = null | boolean | number | string;
export type JsonValue = NestedValue<JsonScalar>;
export type JsonObject = NestedObject<JsonScalar>;
export type JsonArray = NestedArray<JsonScalar>;
