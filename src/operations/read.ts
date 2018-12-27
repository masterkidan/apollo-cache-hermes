import { getMainDefinition, shouldInclude, FragmentMap } from 'apollo-utilities';
import { SelectionSetNode, SelectionNode, DocumentNode } from 'graphql';

import { CacheContext } from '../context';
import { GraphSnapshot } from '../GraphSnapshot';
import { ParsedQuery } from '../ParsedQueryNode';
import { JsonObject, JsonValue, PathPart } from '../primitive';
import { NodeId, OperationInstance, RawOperation, StaticNodeId } from '../schema';
import { isNil, isObject, walkOperation, deepGet, fragmentMapForDocument } from '../util';

import { nodeIdForParameterizedValue } from './SnapshotEditor';

export interface QueryResult {
  /** The value of the root requested by a query. */
  result?: JsonObject;
  /** Whether the query's selection set was satisfied. */
  complete: boolean;
  /** The ids of entity nodes selected by the query. */
  entityIds?: Set<NodeId>;
  /** The ids of nodes overlaid on top of static cache results. */
  dynamicNodeIds?: Set<NodeId>;
  /** The selections that were missing in the cache */
  partitionedQuery: DocumentNode;
}

export interface QueryResultWithNodeIds extends QueryResult {
  /** The ids of entity nodes selected by the query. */
  entityIds: Set<NodeId>;
}

/**
 * Get you some data.
 */
export function read(context: CacheContext, raw: RawOperation, snapshot: GraphSnapshot, includeNodeIds: true): QueryResultWithNodeIds;
export function read(context: CacheContext, raw: RawOperation, snapshot: GraphSnapshot, includeNodeIds?: boolean): QueryResult;
export function read(context: CacheContext, raw: RawOperation, snapshot: GraphSnapshot, includeNodeIds?: boolean) {
  let tracerContext;
  if (context.tracer.readStart) {
    tracerContext = context.tracer.readStart(raw);
  }

  const operation = context.parseOperation(raw);

  // Retrieve the previous result (may be partially complete), or start anew.
  const queryResult = snapshot.readCache.get(operation) || {} as Partial<QueryResultWithNodeIds>;
  snapshot.readCache.set(operation, queryResult as QueryResult);
  let missingFields: SelectionNode[] = [];
  let cacheHit = true;
  if (!queryResult.result) {
    cacheHit = false;
    queryResult.result = snapshot.getNodeData(operation.rootId);

    if (!operation.isStatic) {
      const dynamicNodeIds = new Set<NodeId>();
      queryResult.result = _walkAndOverlayDynamicValues(operation, context, snapshot, queryResult.result, dynamicNodeIds!);
      queryResult.dynamicNodeIds = dynamicNodeIds;
    }

    queryResult.entityIds = includeNodeIds ? new Set<NodeId>() : undefined;

    // When strict mode is disabled, we carry completeness forward for observed
    // queries.  Once complete, always complete.
    const visitResult = _visitSelection(operation, context, queryResult.result, queryResult.entityIds);
    queryResult.complete = visitResult.complete;
    missingFields = visitResult.missingFields;
  }

  // We can potentially ask for results without node ids first, and then follow
  // up with an ask for them.  In that case, we need to fill in the cache a bit
  // more.
  if (includeNodeIds && !queryResult.entityIds) {
    cacheHit = false;
    const entityIds = new Set<NodeId>();
    const visitResult = _visitSelection(operation, context, queryResult.result, entityIds);
    queryResult.complete = visitResult.complete;
    missingFields = visitResult.missingFields;
    queryResult.entityIds = entityIds;
  }
  if (!queryResult.result || missingFields.length === 0) {
    queryResult.partitionedQuery = raw.document;
  } else {
    queryResult.partitionedQuery = partitionQuery(missingFields, raw).document;
  }
  if (context.tracer.readEnd) {
    const result = { result: queryResult as QueryResult, cacheHit };
    context.tracer.readEnd(operation, result, tracerContext);
  }

  return queryResult;
}

function partitionQuery(
  fields: SelectionNode[],
  originalOperation: RawOperation,
): RawOperation {
  const mainDefinition = getMainDefinition(originalOperation.document);
  const fragmentMap = fragmentMapForDocument(originalOperation.document);
  return {
    ...originalOperation,
    document: {
      ...originalOperation.document,
      definitions: [
        {
          ...mainDefinition,
          selectionSet: findMissingSelectionSets(mainDefinition.selectionSet, { variableValues: originalOperation.variables, fragmentMap }, fields),
        },
      ],
    },
  };
}

function findMissingSelectionSets(
  selectionSet: SelectionSetNode,
  execContext: {
    variableValues: any;
    fragmentMap: FragmentMap
  },
  fields: SelectionNode[],
): SelectionSetNode {
  const { variableValues: variables } = execContext;

  const resultSelectionsSet = {
    ...selectionSet,
    selections: [] as SelectionNode[],
  };
  selectionSet.selections.forEach((selection) => {
    if (!shouldInclude(selection, variables)) {
      // Skip this entirely
      return;
    }

    if (selection.kind === 'Field') {
      if (!selection.selectionSet) {
        // Handle scalar selections
        if (fields.indexOf(selection) !== -1) {
          resultSelectionsSet.selections.push(selection);
        } else {
          // Field is not missing and should not be added to the selection set.

        }
      } else {
        // In the case of subselections, if the parent is in the missing list,
        // traversing through the subfields is pointless,
        // hence inserting the parent and continuing.
        if (fields.indexOf(selection) !== -1) {
          resultSelectionsSet.selections.push(selection);
        } else {
          // If parent is not listed as missing, we still need to check the
          // subfields, hence checking those here.
          const selectionToInsert = findMissingSelectionSets(
            selection.selectionSet,
            execContext,
            fields,
          );
          if (selectionToInsert.selections.length > 0) {
            resultSelectionsSet.selections.push({
              ...selection,
              selectionSet: selectionToInsert,
            });
          }
        }
      }
    }
  });
  return resultSelectionsSet;
}

class OverlayWalkNode {
  constructor(
    public readonly value: JsonObject,
    public readonly containerId: NodeId,
    public readonly parsedMap: ParsedQuery,
    public readonly path: PathPart[],
  ) { }
}

/**
 * Walks a parameterized field map, overlaying values at those paths on top of
 * existing results.
 *
 * Overlaid values are objects with prototypes pointing to the original results,
 * and new properties pointing to the parameterized values (or objects that
 * contain them).
 */
export function _walkAndOverlayDynamicValues(
  query: OperationInstance,
  context: CacheContext,
  snapshot: GraphSnapshot,
  result: JsonObject | undefined,
  dynamicNodeIds: Set<NodeId>,
): JsonObject | undefined {
  // Corner case: We stop walking once we reach a parameterized field with no
  // snapshot, but we should also preemptively stop walking if there are no
  // dynamic values to be overlaid
  const rootSnapshot = snapshot.getNodeSnapshot(query.rootId);
  if (isNil(rootSnapshot)) return result;

  // TODO: A better approach here might be to walk the outbound references from
  // each node, rather than walking the result set.  We'd have to store the path
  // on parameterized value nodes to make that happen.

  const newResult = _wrapValue(result, context);
  // TODO: This logic sucks.  We'd do much better if we had knowledge of the
  // schema.  Can we layer that on in such a way that we can support uses w/ and
  // w/o a schema compilation step?
  const queue = [new OverlayWalkNode(newResult, query.rootId, query.parsedQuery, [])];

  while (queue.length) {
    const walkNode = queue.pop()!;
    const { value, parsedMap } = walkNode;
    let { containerId, path } = walkNode;
    const valueId = context.entityIdForValue(value);
    if (valueId) {
      containerId = valueId;
      path = [];
    }

    for (const key in parsedMap) {
      const node = parsedMap[key];
      let child;
      let fieldName = key;

      // This is an alias if we have a schemaName declared.
      fieldName = node.schemaName ? node.schemaName : key;

      let nextContainerId = containerId;
      let nextPath = path;

      if (node.args) {
        let childId = nodeIdForParameterizedValue(containerId, [...path, fieldName], node.args);
        let childSnapshot = snapshot.getNodeSnapshot(childId);
        if (!childSnapshot) {
          let typeName = value.__typename as string;
          if (!typeName && containerId === StaticNodeId.QueryRoot) {
            typeName = 'Query'; // Preserve the default cache's behavior.
          }

          // Should we fall back to a redirect?
          const redirect: CacheContext.ResolverRedirect | undefined = deepGet(context.resolverRedirects, [typeName, fieldName]) as any;
          if (redirect) {
            childId = redirect(node.args);
            if (!isNil(childId)) {
              childSnapshot = snapshot.getNodeSnapshot(childId);
            }
          }
        }

        // Still no snapshot? Ok we're done here.
        if (!childSnapshot) continue;

        dynamicNodeIds.add(childId);
        nextContainerId = childId;
        nextPath = [];
        child = childSnapshot.data;
      } else {
        nextPath = [...path, fieldName];
        child = value[fieldName];
      }

      // Have we reached a leaf (either in the query, or in the cache)?
      if (node.hasParameterizedChildren && node.children && child !== null) {
        if (Array.isArray(child)) {
          child = [...child];
          for (let i = child.length - 1; i >= 0; i--) {
            if (child[i] === null) continue;
            child[i] = _wrapValue(child[i], context);
            queue.push(new OverlayWalkNode(child[i] as JsonObject, nextContainerId, node.children, [...nextPath, i]));
          }

        } else {
          child = _wrapValue(child, context);
          queue.push(new OverlayWalkNode(child as JsonObject, nextContainerId, node.children, nextPath));
        }
      }

      // Because key is already a field alias, result will be written correctly
      // using alias as key.
      value[key] = child;
    }
  }

  return newResult;
}

function _wrapValue(value: JsonValue | undefined, context: CacheContext): any {
  if (value === undefined) return {};
  if (Array.isArray(value)) return [...value];
  if (isObject(value)) {
    const newValue = { ...value };
    if (context.entityTransformer && context.entityIdForValue(value)) {
      context.entityTransformer(newValue);
    }
    return newValue;
  }
  return value;
}

/**
 * Determines whether `result` satisfies the properties requested by
 * `selection`.
 */
export function _visitSelection(
  query: OperationInstance,
  context: CacheContext,
  result?: JsonObject,
  nodeIds?: Set<NodeId>,
): { complete: boolean, missingFields: SelectionNode[] } {
  let complete = true;
  const missingFields: SelectionNode[] = [];
  if (nodeIds && result !== undefined) {
    nodeIds.add(query.rootId);
  }

  // TODO: Memoize per query, and propagate through cache snapshots.
  walkOperation(query.info.parsed, result, (value, fields, parentSelection) => {
    if (value === undefined) {
      complete = false;
      // Parent selection will be undefined if the root query node itself is missing.
      if (parentSelection) {
        missingFields.push(parentSelection);
      }
      return true; // No point traversing the fields if the root itself is not defined.
    }

    if (!isObject(value)) return false;

    if (nodeIds && isObject(value)) {
      const nodeId = context.entityIdForValue(value);
      if (nodeId !== undefined) {
        nodeIds.add(nodeId);
      }
    }

    for (const [field, fieldNode] of fields) {
      if (!(field in value)) {      
        missingFields.push(fieldNode);
        complete = false;
        break;
      }
    }

    return false;
  });

  return { complete, missingFields };
}
