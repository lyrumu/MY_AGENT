---
name: generate-ivory-etched-record
description: Generate project-grounded covers and music visuals using a tactile warm-ivory carved relief material. Treat the bundled reference as material and lighting guidance only; use its record or instrument subject only when the user or project calls for one. Use when the user asks for lyrumu's pale carved texture, including README covers and branded project visuals.
---

# Generate Ivory Relief Project Visuals

Transfer a tactile warm-ivory carved material language onto the user's actual subject. The current request and project determine what appears in the image; this skill determines how ivory elements feel, catch light, and reveal shallow relief.

## Subject hierarchy

Use this order of authority:

1. The user's requested subject, composition, copy, and output format.
2. Concrete project evidence such as its README, screenshots, UI, features, brand mark, and palette.
3. This skill's material and lighting language.
4. The bundled reference image.

Never promote an object from the reference into the new image merely because it is visually distinctive. A record, circular disc, spindle hole, concentric grooves, or carved instrument may appear when the user requests it or the project naturally supports it; otherwise do not introduce it. When such an object is project-appropriate, redesign it for the current composition instead of reproducing the reference object.

For a project cover, inspect the accessible project context before writing the prompt. Select three to five concrete, recognizable project elements and make them the visual subject. Do not fill missing space with generic music or technology props.

## Reference

Use [assets/ivory-etched-record-reference.png](assets/ivory-etched-record-reference.png) only to inspect these qualities:

- warm ivory stone, matte porcelain, or fine plaster texture;
- shallow bas-relief edges, faint tool marks, and micro-occlusion;
- low-contrast warm whites revealed by grazing upper-left light;
- restrained contact shadows and broad matte highlights.

Do not treat its disc, instrument, grooves, layout, hierarchy, text, avatar, or navigation as reusable content. Prefer a text-only generation prompt after extracting the material qualities above. Attach the reference image only when material fidelity cannot be achieved otherwise, and state explicitly that its objects and composition are excluded.

If a generated result repeats the reference subject without a current-project reason, reject it. Do not retain that image or the visual reference during the next attempt; restart from the project brief with a text-only material description.

## Material language

Apply only the traits that suit the user's subject:

- Warm ivory stone, matte porcelain, fine plaster, or tactile paper-clay surfaces.
- Shallow same-material bas-relief with raised edges, recessed seams, delicate tool marks, and soft micro-occlusion.
- Warm off-white values remain close together. Form is revealed by light and micro-shadow, not by strong outlines or added color.
- Physical thickness, restrained bevels, and slight natural irregularity make objects feel manufactured yet sculptural.
- Preserve project colors as limited inlays or accents when they are part of its identity; do not bleach an established brand into an all-ivory image.

When the user explicitly requests an etched record, additionally use a thick ivory disc, fine concentric grooves, a small spindle hole, a restrained rim, and a shallow same-material relief of the requested subject. These are optional record-mode traits, not defaults for every project visual.

## Light and framing

- Use a large diffused key light from the upper-left or upper-front at a shallow angle.
- Add soft ambient fill and restrained contact shadows below/right of the primary relief objects.
- Keep highlights matte and broad; retain detail in whites without blown-out areas.
- Prefer a straight-on or lightly elevated product-study view with generous negative space when it supports the requested asset.
- Follow the user's or project's visual hierarchy. Do not make the reference disc the focus by default.

## Default exclusions

Avoid glossy plastic, metallic CD reflections, generic black vinyl, printed stickers, deep-cut stone relief, heavy outlines, dramatic shadows, ornate filler, invented text, unrelated logos, and watermarks.

Do not use named consumer-brand styles as shorthand. Express the actual material, light, spacing, and contrast requirements instead.

## Prompt construction

Before generating, separate the prompt into two sources:

- **Project-derived content:** asset type, subject, objects, UI, workflow, composition, brand shape, palette, copy, and aspect ratio.
- **Reference-derived treatment:** ivory material, shallow relief, tool marks, grazing light, matte highlights, and restrained shadows.

If an object cannot be justified by the first list, omit it even when it appears in the reference.

For project covers and branded visuals, use this core block:

```text
Content source: depict only [PROJECT ELEMENTS] using [PROJECT COMPOSITION, PALETTE, AND HIERARCHY]. These subjects come from the current project, not from the material reference.

Material treatment only: warm-ivory stone/porcelain/paper-clay surfaces, shallow same-material bas-relief, delicate carved edges, subtle recessed seams, faint tool marks, realistic micro-occlusion, large diffused upper-left light, soft ambient fill, narrow contact shadows, matte highlights, and low-contrast warm whites. Preserve limited project color accents. The result should feel like a photographed physical sculpture rather than a flat illustration.

Do not copy any reference subject, hero object, composition, layout, or symbol. Do not add a record, instrument, groove pattern, or spindle hole unless it is independently required by the current project brief.
```

For an explicitly requested ivory etched-record image, add the record-mode traits from **Material language** to this block. Add exact text separately and quote it verbatim. Do not invent copy.

## Quality check

Before accepting the result, verify all five:

1. A viewer can identify concrete subjects from the user's request or project rather than from the reference image.
2. No reference object, composition, or symbol appears without an independent project reason.
3. Ivory elements read as physical shallow relief with legible detail through grazing light and micro-shadow.
4. Project palette, brand shapes, and hierarchy remain recognizable where evidence exists.
5. No invented copy, stray glyphs, unrelated decorative filler, glossy synthetic cues, or watermark appears.

If only material rendering fails, refine that defect while retaining the latest acceptable composition. If subject leakage from the reference occurs, discard that direction and regenerate from the project-derived content list without attaching the reference image.
