import { faker } from "@faker-js/faker";
import type {
  ArrayType,
  CollectedTypes,
  RecordType,
  ValueType,
} from "@previewjs/type-analyzer";
import {
  STRING_TYPE,
  arrayType,
  dereferenceType,
  isValid,
} from "@previewjs/type-analyzer";
import assertNever from "assert-never";
import { formatExpression } from "./format-expression";
import { isValidPropName } from "./prop-name";
import type {
  SerializableArrayValue,
  SerializableObjectValue,
  SerializableObjectValueEntry,
  SerializableValue,
} from "./serializable-value";
import {
  EMPTY_ARRAY,
  EMPTY_OBJECT,
  FALSE,
  NULL,
  TRUE,
  UNDEFINED,
  array,
  fn,
  map,
  number,
  object,
  promise,
  set,
  string,
} from "./serializable-value";
import { serializableValueToJavaScript } from "./serializable-value-to-js";

/**
 * Generates a valid value for the given type.
 */
export async function generateSerializableValue(
  type: ValueType,
  collected: CollectedTypes,
  options: {
    fieldName?: string;
    random?: boolean;
  } = {}
): Promise<SerializableValue> {
  return await _generateSerializableValue(
    type,
    collected,
    options.fieldName || "",
    [],
    options.random || false,
    false
  );
}

async function _generateSerializableValue(
  type: ValueType,
  collected: CollectedTypes,
  fieldName: string,
  rejectTypeNames: string[],
  random: boolean,
  isFunctionReturnValue: boolean
): Promise<SerializableValue> {
  let encounteredAliases: string[];
  [type, encounteredAliases] = dereferenceType(
    type,
    collected,
    rejectTypeNames
  );
  rejectTypeNames = [...rejectTypeNames, ...encounteredAliases];
  switch (type.kind) {
    case "any":
    case "unknown":
    case "never":
    case "void":
      return UNDEFINED;
    case "null":
      return NULL;
    case "boolean":
      return random && Math.random() < 0.5 ? TRUE : FALSE;
    case "string":
      return string(
        random
          ? faker.lorem.words(generateRandomInteger(0, 10))
          : stringFromFieldName(fieldName)
      );
    case "node":
      return await _generateSerializableValue(
        STRING_TYPE,
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    case "number":
      return number(random ? generateRandomInteger() : 0);
    case "literal":
      if (typeof type.value === "number") {
        return number(type.value);
      } else if (typeof type.value === "string") {
        return string(type.value);
      } else {
        return type.value ? TRUE : FALSE;
      }
    case "enum": {
      const optionValues = Object.values(type.options);
      const value =
        optionValues[
          random ? generateRandomInteger(0, optionValues.length) : 0
        ];
      if (typeof value === "number") {
        return number(value);
      } else {
        return string(value || "unknown");
      }
    }
    case "array":
      return generateArrayValue(
        type,
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    case "set":
      return set(
        await generateArrayValue(
          arrayType(type.items),
          collected,
          fieldName,
          rejectTypeNames,
          random,
          isFunctionReturnValue
        )
      );
    case "tuple":
      return array(
        await Promise.all(
          type.items.map((item) =>
            _generateSerializableValue(
              item,
              collected,
              fieldName,
              rejectTypeNames,
              random,
              isFunctionReturnValue
            )
          )
        )
      );
    case "object": {
      const entries: SerializableObjectValueEntry[] = [];
      for (const [propName, propType] of Object.entries(type.fields)) {
        let nonOptionalPropType =
          propType.kind === "optional" ? propType.type : propType;
        if (propType.kind === "optional" && (!random || Math.random() < 0.5)) {
          continue;
        }
        const propValue = await _generateSerializableValue(
          nonOptionalPropType,
          collected,
          propName,
          rejectTypeNames,
          random,
          isFunctionReturnValue
        );
        if (propValue.kind === "undefined") {
          continue;
        }
        if (!isValidPropName(propName)) {
          continue;
        }
        entries.push({
          kind: "key",
          key: string(propName),
          value: propValue,
        });
      }
      return object(entries);
    }
    case "map":
      return map(
        await generateRecordValue(
          {
            ...type,
            kind: "record",
          },
          collected,
          fieldName,
          rejectTypeNames,
          random,
          isFunctionReturnValue
        )
      );
    case "record":
      return generateRecordValue(
        {
          ...type,
          kind: "record",
        },
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    case "union":
      if (!random) {
        if (isValid(type, collected, undefined)) {
          return UNDEFINED;
        }
        if (isValid(type, collected, null)) {
          return NULL;
        }
        if (isValid(type, collected, false)) {
          return FALSE;
        }
      }
      return await _generateSerializableValue(
        type.types[random ? generateRandomInteger(0, type.types.length) : 0]!,
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    case "intersection":
      // Generate a value for the first type and hope for the best.
      return await _generateSerializableValue(
        type.types[0]!,
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    case "function": {
      if (isFunctionReturnValue) {
        // Do not generate complex functions within functions.
        return fn(`() => {}`);
      }
      const returnValue = await serializableValueToJavaScript(
        await _generateSerializableValue(
          type.returnType,
          collected,
          fieldName,
          rejectTypeNames,
          random,
          true
        )
      );
      return fn(
        await formatExpression(
          `() => {
            console.log(${JSON.stringify(fieldName + " invoked")});
            ${returnValue === "undefined" ? "" : `return ${returnValue};`}
          }`
        )
      );
    }
    case "promise": {
      return promise({
        type: "reject",
        message: null,
      });
    }
    case "name":
      // This recursion is safe specifically because rejectTypeNames
      // is updated before.
      return await _generateSerializableValue(
        type,
        collected,
        fieldName,
        rejectTypeNames,
        random,
        isFunctionReturnValue
      );
    default:
      throw assertNever(type);
  }
}

function stringFromFieldName(fieldName: string) {
  // If a field looks like "abc:def" then return "def".
  const columnPosition = fieldName.lastIndexOf(":");
  if (columnPosition === -1) {
    return fieldName.trim();
  }
  return fieldName.substring(columnPosition + 1).trim();
}

async function generateArrayValue(
  type: ArrayType,
  collected: CollectedTypes,
  fieldName: string,
  rejectTypeNames: string[],
  random: boolean,
  isFunctionReturnValue: boolean
): Promise<SerializableArrayValue> {
  if (isFunctionReturnValue) {
    // Avoid unnecessarily verbose generated props when they're
    // unlikely to even be used at all.
    return EMPTY_ARRAY;
  }
  const itemValues: SerializableValue[] = [];
  const length = random ? generateRandomInteger(0, 3) : 1;
  for (let i = 0; i < length; i++) {
    const itemValue = await _generateSerializableValue(
      type.items,
      collected,
      fieldName,
      rejectTypeNames,
      random,
      isFunctionReturnValue
    );
    itemValues.push(itemValue);
  }
  if (
    itemValues.every(
      (itemValue) =>
        itemValue.kind === "undefined" ||
        (itemValue.kind === "object" &&
          Object.keys(itemValue.entries).length === 0)
    )
  ) {
    return EMPTY_ARRAY;
  }
  return array(itemValues);
}

async function generateRecordValue(
  type: RecordType,
  collected: CollectedTypes,
  fieldName: string,
  rejectTypeNames: string[],
  random: boolean,
  isFunctionReturnValue: boolean
): Promise<SerializableObjectValue> {
  if (!random) {
    return EMPTY_OBJECT;
  }
  const { items: values } = await generateArrayValue(
    {
      kind: "array",
      items: type.values,
    },
    collected,
    fieldName,
    rejectTypeNames,
    random,
    isFunctionReturnValue
  );
  const entries: SerializableObjectValueEntry[] = [];
  for (const value of values) {
    const key = await _generateSerializableValue(
      type.keys,
      collected,
      fieldName,
      rejectTypeNames,
      random,
      isFunctionReturnValue
    );
    entries.push({
      kind: "key",
      key,
      value,
    });
  }
  return object(entries);
}

function generateRandomInteger(minInclusive = -5000, maxExclusive = +5000) {
  const range = maxExclusive - minInclusive;
  return Math.floor(Math.random() * range + minInclusive);
}
