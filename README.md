# Formicarium

A browser-based ant-colony observation diorama built with Three.js and generated natural-history sprite artwork.

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
- Shift-click: place a stone obstacle
- `B`: smoothly toggle between the surface and underground nest
- Double-click: focus the camera
- `R`: call rain
- Space: pause
- `F`: fullscreen
