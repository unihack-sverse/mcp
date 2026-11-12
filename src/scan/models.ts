/** The exact shape `scan_project` accepts (`publish.service.js` STEP_INPUT.scan_project). */
export type Engine = 'unity' | 'godot' | 'js' | 'unreal' | 'other';

export interface ScanResult {
  engine: Engine;
  engineVersion?: string;
  scenes?: number;
  surfaces?: number;
  monetizableObjects?: string[];
}

/** What the tool returns to the model: the API payload plus everything it could and could not determine. */
export interface ScanReport extends ScanResult {
  /** Absolute path that was scanned. */
  path: string;
  /** Every heuristic signal that contributed, for auditability. */
  signals: ScanSignal[];
  /** Files visited before the traversal cap; compare with `truncated` to judge completeness. */
  filesVisited: number;
  /** True when the traversal cap stopped the walk, so every count is a lower bound. */
  truncated: boolean;
  /** Anything the tool could not determine. Empty only when the scan is complete and unambiguous. */
  notes: string[];
  /** Scene files found, relative to the project root, capped for output size. */
  sceneFiles: string[];
}

export interface ScanSignal {
  /** Relative path of the file that produced the signal. */
  file: string;
  /** Human-readable reason, e.g. "ProjectSettings/ProjectVersion.txt". */
  reason: string;
}
