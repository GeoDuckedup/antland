# Formicarium

A browser-based ant-colony observation diorama built with Three.js and generated natural-history sprite artwork.

Two persistent, genetically distinct colonies share the surface ecosystem. Workers inherit mutable speed, size, disease-resistance, aggression, and foraging traits; natural selection changes the living population as generations turn over. Colonies forage from shared food, defend shifting territories, maintain separate queens and brood, survive beetle and web-spider predation, and expose distinct underground nests. Seasonal frost, leaf-fall, vegetation color, food, rain, disease, injury, death, and replacement make colony growth reversible.

Run from a local web server:

```sh
python3 -m http.server 5173
```

Then open `http://127.0.0.1:5173`.

## Interaction

- `WASD` or arrow keys: move through the current layer
- Hold Shift: move faster
- `Q` / `E`: descend or ascend
- Drag: orbit the diorama, including below the surface
- Right-drag: pan
- Wheel: zoom
- Click: add food
- Click an ant: follow it and open its field note
- Shift-click: place a stone obstacle
- `B`: smoothly toggle between the surface and underground nest
- `N`: switch underground focus between colonies
- Double-click: focus the camera
- `R`: call rain
- `P`: introduce a hunting beetle
- `O`: introduce a web-building spider
- `[` / `]`: slow down or accelerate simulation time
- `0`: return to normal time
- Space: pause
- `F`: fullscreen
