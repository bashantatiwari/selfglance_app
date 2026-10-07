// A character is a folder under public/characters/<id>/ with a character.json
// manifest + a model. Adding a new character means dropping in a new folder and
// listing it in characters/index.json — no code changes.

/** Logical animation names the app asks for; each manifest maps them to its own clips. */
export type ClipName = "idle" | "walk" | "wave" | "celebrate" | "nod" | "dance" | "hang" | "sit" | "annoyed" | "determined";

/** An animation stored in its own file — how Mixamo exports clips (one .fbx per animation). */
export interface ClipFile {
  file: string;
  /** Clip name inside the file; omitted = the file's first clip. */
  clip?: string;
}

export interface CharacterManifest {
  id: string;
  name: string;
  /** Model file inside the character folder: .glb / .gltf / .fbx. */
  model: string;
  /** On-screen height in CSS pixels. */
  height: number;
  /** Logical clip -> clip name embedded in the model file. */
  clips?: Partial<Record<ClipName, string>>;
  /** Logical clip -> separate animation file (Mixamo workflow). Wins over `clips`. */
  animations?: Partial<Record<ClipName, ClipFile>>;
  /** Bone that holds props such as the water bottle (e.g. "Palm2.L", "mixamorigLeftHand"). */
  holdBone?: string;
  /** Upper-leg bones (left, right) bent to sit down, e.g. ["UpperLeg.L","UpperLeg.R"]. */
  legBones?: string[];
  /** How the character arrives. */
  entrance: "web-drop";
  /** Model faces +z by default; set to rotate it (radians) so it faces the user. */
  turn?: number;
  credit?: string;
}

/** Rectangle in CSS pixels, top-left origin (same space as the DOM). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
