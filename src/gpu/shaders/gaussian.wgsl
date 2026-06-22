// Separable Gaussian blur, one axis per dispatch.
// Reads from an input storage buffer of RGBA f32 (linear 0..1), writes to output.
// Params: { width, height, radius, axis }  axis 0 = horizontal, 1 = vertical.

struct Params {
  width: u32,
  height: u32,
  radius: i32,
  axis: u32,
};

@group(0) @binding(0) var<storage, read> inBuf: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn idx(x: i32, y: i32) -> u32 {
  let cx = clamp(x, 0, i32(params.width) - 1);
  let cy = clamp(y, 0, i32(params.height) - 1);
  return u32(cy) * params.width + u32(cx);
}

// Approximate gaussian weight; sigma ~ radius/2.
fn weight(d: f32, sigma: f32) -> f32 {
  return exp(-(d * d) / (2.0 * sigma * sigma));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let r = params.radius;
  if (r < 1) {
    outBuf[idx(x, y)] = inBuf[idx(x, y)];
    return;
  }
  let sigma = max(f32(r) * 0.5, 0.5);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var i = -r; i <= r; i = i + 1) {
    let w = weight(f32(i), sigma);
    var sx = x;
    var sy = y;
    if (params.axis == 0u) { sx = x + i; } else { sy = y + i; }
    acc = acc + inBuf[idx(sx, sy)] * w;
    wsum = wsum + w;
  }
  outBuf[idx(x, y)] = acc / wsum;
}
