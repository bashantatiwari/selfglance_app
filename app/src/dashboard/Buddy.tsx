// Settings → Buddy: make your own buddy from a photo (a partner, a friend, a pet), or go back to Bond
// the robot. The sticker is made on this laptop (stage/buddy.ts) and the overlay swaps to it at once.

import { useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { inTauri } from "../platform";
import { BUDDY_EVENT, loadBuddy, makeSticker, photoCanvas, saveBuddy, type Buddy, type Made, type StickerStyle } from "../stage/buddy";
import { toast } from "./ui";

const SIZES = [
  { h: 120, name: "Small" },
  { h: 150, name: "Medium" },
  { h: 190, name: "Large" },
];
const STYLES: { id: StickerStyle; name: string; hint: string }[] = [
  { id: "cutout", name: "Cut-out", hint: "Just them, background gone" },
  { id: "round", name: "Round sticker", hint: "Works with any photo" },
];

/** Tell the overlay (another window) that the buddy changed. */
const announce = () => {
  if (inTauri) void emit(BUDDY_EVENT).catch(() => {});
};

export function BuddyPanel() {
  const [current, setCurrent] = useState<Buddy | null>(loadBuddy);
  const [made, setMade] = useState<Record<StickerStyle, Made> | null>(null);
  const [style, setStyle] = useState<StickerStyle>("cutout");
  const [name, setName] = useState(current?.name ?? "");
  const [size, setSize] = useState(current?.height ?? 150);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setWorking(true);
    try {
      const photo = await photoCanvas(file);
      const both = { cutout: makeSticker(photo, "cutout"), round: makeSticker(photo, "round") };
      setMade(both);
      setStyle(both.cutout.url ? "cutout" : "round");
    } catch {
      setError("I couldn't open that picture. Try a JPG or PNG.");
    } finally {
      setWorking(false);
    }
  };

  const keep = (b: Buddy | null, said: string) => {
    if (!saveBuddy(b)) return setError("That sticker is too big to keep. Try a smaller photo.");
    announce();
    setCurrent(b);
    toast(said);
  };
  const use = () => {
    const url = made?.[style].url;
    if (!url) return;
    keep({ name: name.trim().slice(0, 30) || "Buddy", url, height: size, at: Date.now() }, `${name.trim() || "Your buddy"} is on your desktop`);
    setMade(null);
  };
  const resize = (h: number) => {
    setSize(h);
    if (current && !made) keep({ ...current, height: h, at: Date.now() }, "Size changed");
  };

  const shown = made?.[style].url ?? current?.url;
  return (
    <section className="group">
      <div className="group-info">
        <h2>Buddy</h2>
        <p className="muted">Put someone you love on your desktop: a partner, a friend, your cat. Pick a photo and they become a little moving sticker that brings your water and cheers you on.</p>
        <p className="muted small">The photo is made into a sticker on this laptop and never leaves it.</p>
      </div>
      <div className="group-body">
        <div className="buddy-now">
          <div className="buddy-stage" style={{ height: Math.max(size, 150) + 30 }}>
            {shown ? <img src={shown} alt="" style={{ height: size }} /> : <span className="muted small">Bond the robot</span>}
          </div>
          <div className="buddy-actions">
            <label className="btn">
              {working ? "Making the sticker…" : current || made ? "Choose another photo" : "Choose a photo"}
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={working} onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
            {current && !made && (
              <button className="btn ghost" onClick={() => keep(null, "Bond the robot is back")}>
                Back to Bond the robot
              </button>
            )}
          </div>
        </div>

        {made && (
          <>
            <div className="buddy-styles" role="radiogroup" aria-label="Sticker style">
              {STYLES.map((s) => (
                <button key={s.id} role="radio" aria-checked={style === s.id} className={`buddy-style ${style === s.id ? "on" : ""}`} disabled={!made[s.id].url} onClick={() => setStyle(s.id)}>
                  <span className="buddy-thumb">{made[s.id].url ? <img src={made[s.id].url!} alt="" /> : <span className="muted small">—</span>}</span>
                  <b>{s.name}</b>
                  <small className="muted">{made[s.id].url ? s.hint : made[s.id].why}</small>
                </button>
              ))}
            </div>
            <label className="buddy-name">
              <span>Name</span>
              <input className="capture-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mimi" maxLength={30} />
            </label>
          </>
        )}

        <div className="buddy-size">
          <span>Size</span>
          <div className="tabs" role="radiogroup" aria-label="Buddy size">
            {SIZES.map((s) => (
              <button key={s.h} role="radio" aria-checked={size === s.h} className={size === s.h ? "on" : ""} onClick={() => resize(s.h)}>
                {s.name}
              </button>
            ))}
          </div>
        </div>

        {made && (
          <div className="buddy-actions">
            <button className="btn" disabled={!made[style].url} onClick={use}>
              Use as my buddy
            </button>
            <button className="btn ghost" onClick={() => setMade(null)}>
              Cancel
            </button>
          </div>
        )}
        {error && <p className="buddy-error small">{error}</p>}
        <p className="muted small">
          Cleanest cut-out: a photo on a plain background. For a busy photo, open it in Windows Paint, press <b>Remove background</b>, save it as PNG and pick that file here.
        </p>
      </div>
    </section>
  );
}
