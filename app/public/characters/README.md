# Adding your own character (e.g. a web-slinger)

A character is a folder here with a `character.json` + model files, listed in
`index.json`. Use the tray menu → **Switch character** to cycle through them.

> Copyrighted characters (Spider-Man, Iron Man, ...) are for **your own personal
> use only**. Folders you add here are git-ignored so they never get published.

## Fastest route: Mixamo (free, ~10 minutes)

1. Get a humanoid 3D model you're allowed to use personally (`.fbx` or `.obj`),
   e.g. a fan-made model from Sketchfab — check its license.
2. Go to <https://www.mixamo.com> (free Adobe account) → **Upload Character** →
   place the markers (chin, wrists, elbows, knees, groin) → Mixamo rigs it.
3. Download these animations, each as **FBX Binary, "With Skin" for the first
   one only, 30 fps**. Tick **In Place** on walking animations:

   | Logical name | Suggested Mixamo animation |
   | --- | --- |
   | idle | "Breathing Idle" |
   | walk | "Walking" (In Place) |
   | wave | "Waving" |
   | celebrate | "Fist Pump" or "Victory" |
   | nod | "Head Nod Yes" |
   | dance | "Hip Hop Dancing" |
   | hang | "Hanging Idle" (perfect for the web-drop!) |

4. Put them in a folder, e.g. `spiderman/`:

   ```
   spiderman/
     model.fbx        <- the "With Skin" download (e.g. your idle)
     walk.fbx  wave.fbx  celebrate.fbx  nod.fbx  dance.fbx  hang.fbx
     character.json
   ```

5. `character.json`:

   ```json
   {
     "id": "spiderman",
     "name": "Spidey",
     "model": "model.fbx",
     "height": 160,
     "animations": {
       "idle": { "file": "model.fbx" },
       "walk": { "file": "walk.fbx" },
       "wave": { "file": "wave.fbx" },
       "celebrate": { "file": "celebrate.fbx" },
       "nod": { "file": "nod.fbx" },
       "dance": { "file": "dance.fbx" },
       "hang": { "file": "hang.fbx" }
     },
     "entrance": "web-drop",
     "theme": "jarvis"
   }
   ```

6. Add `"spiderman"` to `characters` in `index.json`, then **Switch character**.

Tips: if the character faces away, add `"turn": 3.1416`. If it is too big or
small, change `height` (pixels). GLB/GLTF models with built-in clips use
`"clips": { "idle": "<clip name>" }` instead of `animations`.
