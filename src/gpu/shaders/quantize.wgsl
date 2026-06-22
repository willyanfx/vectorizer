// Per-channel uniform quantization: snap each RGB channel to `levels` steps.
// This reduces the color count before tracing (fewer, cleaner layers) and runs
// fully parallel on the GPU. (True palette median-cut stays on the CPU path.)

struct Params {
  width: u32,
  height: u32,
  levels: u32, // number of steps per channel (>= 2)
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> inBuf: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let i = gid.y * params.width + gid.x;
  let c = inBuf[i];
  let steps = f32(max(params.levels, 2u) - 1u);
  let q = vec3<f32>(
    round(c.r * steps) / steps,
    round(c.g * steps) / steps,
    round(c.b * steps) / steps,
  );
  outBuf[i] = vec4<f32>(q, c.a);
}
