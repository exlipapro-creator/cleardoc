/**
 * ClearDoc Removal Planner
 * Constructs a machine-readable, deterministic removal plan selecting the least destructive strategy.
 */
import {
  WatermarkCandidate,
  ManualRegion,
  RemovalPlan,
  RemovalStrategy,
  RemovalPlanOperation,
} from '../../shared/types.js';
import { CONFIG } from '../config.js';

export function constructRemovalPlan(
  documentId: string,
  selectedCandidates: WatermarkCandidate[],
  manualRegions: ManualRegion[] = [],
  preferredStrategy?: RemovalStrategy
): RemovalPlan {
  const operations: RemovalPlanOperation[] = [];

  // Determine least-destructive strategy
  let strategy: RemovalStrategy = preferredStrategy || 'NATIVE_OBJECT_REMOVAL';

  // Process selected candidates
  for (const candidate of selectedCandidates) {
    for (const page of candidate.pages) {
      if (candidate.representation === 'PDF_TEXT_OBJECT') {
        operations.push({
          page,
          targetCandidateId: candidate.id,
          operation: 'REMOVE_TEXT_OBJECT',
          details: {
            text: candidate.text,
            bbox: candidate.bbox,
            rotation: candidate.rotation,
          },
        });
      } else if (candidate.representation === 'PDF_XOBJECT') {
        operations.push({
          page,
          targetCandidateId: candidate.id,
          operation: 'REMOVE_XOBJECT',
          details: {
            bbox: candidate.bbox,
          },
        });
      } else if (candidate.representation === 'PDF_VECTOR_PATH') {
        operations.push({
          page,
          targetCandidateId: candidate.id,
          operation: 'REMOVE_VECTOR_PATH',
          details: {
            bbox: candidate.bbox,
          },
        });
      } else {
        operations.push({
          page,
          targetCandidateId: candidate.id,
          operation: 'RESTORE_RASTER_REGION',
          details: {
            bbox: candidate.bbox,
          },
        });
      }
    }
  }

  // Process user manual regions
  for (const manual of manualRegions) {
    operations.push({
      page: manual.page,
      targetCandidateId: manual.id,
      operation: 'RESTORE_RASTER_REGION',
      details: {
        bbox: manual.bbox,
        isManual: true,
      },
    });
  }

  return {
    documentId,
    strategy,
    engineVersion: CONFIG.ENGINE_VERSIONS,
    operations,
    createdAt: new Date().toISOString(),
  };
}
