import { SelectionNode } from 'graphql';

import { ParsedQueryWithVariables } from '../ParsedQueryNode';
import { JsonObject, JsonValue, PathPart } from '../primitive';

class OperationWalkNode {
  constructor(
    public readonly parsedOperation: ParsedQueryWithVariables,
    public readonly parentSelection: SelectionNode,
    public readonly parent?: JsonValue,
  ) { }
}

/**
 * Returning true indicates that the walk should STOP.
 */
export type OperationVisitor = (parent: JsonValue | undefined, fields: [string, SelectionNode][], parentSelection: SelectionNode) => boolean;

/**
 * Walk and run on ParsedQueryNode and the result.
 * This is used to verify result of the read operation.
 */
export function walkOperation(rootOperation: ParsedQueryWithVariables, result: JsonObject | undefined, visitor: OperationVisitor) {

  // Perform the walk as a depth-first traversal; and unlike the payload walk,
  // we don't bother tracking the path.
  const stack = [new OperationWalkNode(rootOperation, <unknown>undefined as SelectionNode, result)];

  while (stack.length) {
    const { parsedOperation, parent, parentSelection } = stack.pop()!;
    // We consider null nodes to be skippable (and satisfy the walk).
    if (parent === null) continue;

    // Fan-out for arrays.
    if (Array.isArray(parent)) {
      // Push in reverse purely for ergonomics: they'll be pulled off in order.
      for (let i = parent.length - 1; i >= 0; i--) {
        stack.push(new OperationWalkNode(parsedOperation, parentSelection, parent[i]));
      }
      continue;
    }

    const fields: [string, SelectionNode][] = [];
    // TODO: Directives?
    for (const fieldName in parsedOperation) {
      fields.push([fieldName, parsedOperation[fieldName].selection]);
    }

    if (fields.length) {
      // NOTE: If fields have been walked, then selections will be present for those fields, except in the case 
      // of root level selections.
      const shouldStop = visitor(parent, fields, parentSelection);
      // shouldStop == true if the parent itself is undefined/ if any of the selections are not defined. 
      // When shouldStop == false, we must actually visit the children to see if the grandchildren are defined as well.
      if (!shouldStop) {
        for (const fieldName in parsedOperation) {
          const nextParsedQuery = parsedOperation[fieldName].children;
          if (nextParsedQuery) {
            // Queuing up the children walk, pass in the parent as the current selection node.
            stack.push(new OperationWalkNode(nextParsedQuery, parsedOperation[fieldName].selection, get(parent, fieldName)));
          }
        }
      }
    }
  }
}

export function get(value: any, key: PathPart) {
  // Remember: arrays are typeof 'object', too.
  return value !== null && typeof value === 'object' ? value[key] : undefined;
}
