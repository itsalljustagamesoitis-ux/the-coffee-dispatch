# Safety Topics Taxonomy — Platform Reference

Per-niche safety topic registry for the `safety_topics:` frontmatter field.
The `SafetyNotice` component renders a notice for each topic slug listed in an
article's `safety_topics:` array.

New niche launches must define their taxonomy here before the first production
batch. The producer cannot auto-assign topics that are not in this file.

---

## Adding a new niche

1. Define slug(s) and notice text below
2. Add slug(s) to `SafetyNotice.astro` Props interface AND `notices` record
3. Add slug(s) to the site's `content.config.ts` `safety_topics` enum
4. Verify `npm run build` passes in the site repo
5. Update the status table in `LEAKS.md`

---

## FSG — Four Season Gardener (gardening / outdoor)

```
safety_topics: z.array(z.enum([
  'heating',
  'power-equipment',
  'electrical',
  'chemical',
])).optional()
```

| Slug | Applies to |
|------|-----------|
| `heating` | Patio heaters, fire pits, propane burners |
| `power-equipment` | Lawnmowers, chainsaws, angle grinders, leaf blowers |
| `electrical` | Outdoor lighting, weatherproof fixtures, hardwired garden kit |
| `chemical` | Pesticides, herbicides, fertilisers, pest control |

---

## MLT — My Little Tablespoon (kitchen cookware)

```
safety_topics: z.array(z.enum([
  'blades',
  'high-heat',
  'cookware-coatings',
])).optional()
```

| Slug | Applies to |
|------|-----------|
| `blades` | Mandolines, slicers, knives, food processors with blades |
| `high-heat` | Stovetop/oven cookware, cast iron, Dutch ovens |
| `cookware-coatings` | Nonstick pans, ceramic-coated cookware |

Note: `electrical` was reviewed but not adopted for MLT — the notice text
references outdoor weatherproofing which is irrelevant in a kitchen context.

---

## TCD — The Coffee Dispatch (coffee equipment)

```
safety_topics: z.array(z.enum([
  'espresso-pressure',
  'electric-grinder',
  'moka-pot-heat',
])).optional()
```

| Slug | Applies to |
|------|-----------|
| `espresso-pressure` | Espresso machines (pump and lever), pressure gauges, repair/rental articles |
| `electric-grinder` | Electric burr grinders (commercial and home); NOT manual/hand grinders |
| `moka-pot-heat` | Moka pot articles (all sizes, materials, and accessories including gaskets) |

Articles tagged (2026-05-13):
- `espresso-pressure`: 33 articles (all espresso machine slugs)
- `electric-grinder`: 23 articles (all electric burr grinder slugs)
- `moka-pot-heat`: 9 articles (all moka pot slugs)

---

## OHT — One Happy Table (home entertaining / dinnerware)

No safety topics defined. Niche (tableware, serveware, entertaining) has no
meaningful hazards requiring a safety notice. `safety_topics:` field omitted
from `content.config.ts`.

---

## BCB — Bear Creek Barbecue (proposed)

Not yet launched. Proposed taxonomy for grill/smoker niche:

```
safety_topics: z.array(z.enum([
  'grill-fire',
  'propane',
  'charcoal-monoxide',
  'cross-contamination',
  'food-temperature',
])).optional()
```

| Slug | Applies to | Draft notice text |
|------|-----------|-------------------|
| `grill-fire` | Charcoal and gas grills, kamado grills, smokers | Keep a fire extinguisher rated for grease fires (Class K or Class B) within reach. Never use a grill indoors or in an enclosed space. Clear a 3-foot zone around the grill before lighting. |
| `propane` | Propane grills, smokers, side burners, griddles | Check propane hose connections for leaks before each use — apply soapy water and look for bubbles. Never store propane cylinders indoors or in a vehicle. Close the tank valve before disconnecting. |
| `charcoal-monoxide` | Charcoal grills, charcoal smokers, kamado grills | Charcoal produces carbon monoxide. Never light or use a charcoal grill indoors, in a garage, or under a partially covered area without full ventilation. Wait for coals to be fully extinguished before storing in an enclosed space. |
| `cross-contamination` | Cutting boards, meat prep tools, marinade containers | Use separate boards for raw meat and produce. Never return cooked meat to a surface or container that held it raw. Wash hands, boards, and utensils with hot soapy water immediately after contact with raw meat. |
| `food-temperature` | Meat thermometers, probe thermometers, instant-read thermometers | USDA safe internal temperatures: beef/pork/lamb 145°F (63°C), ground meat 160°F (71°C), poultry 165°F (74°C). Always verify with a probe thermometer — colour is not a reliable indicator of doneness. |

**Status:** taxonomy proposed, not yet implemented. Must be added to
`SafetyNotice.astro` and `content.config.ts` before first BCB production run.
