#include <algorithm>
#include <array>
#include <cstdint>

namespace EnergyDispatchDemo {

struct ControlConfig {
  double demand_limit = 120.0;
  double storage_reserve = 18.0;
};

struct DispatchFrame {
  std::array<double, 4> bus_loads{};
  std::array<double, 4> targets{};
  double storage_state = 64.0;
  double temperature = 42.0;
  double voltage = 750.0;
  bool alarm = false;
};

std::int64_t monotonic_time_ms() {
  return 1'725'236'215'000;
}

DispatchFrame allocate_frame() {
  return DispatchFrame{};
}

ControlConfig load_control_config() {
  return ControlConfig{};
}

double normalize_samples(double value) {
  return std::clamp(value, 0.0, 1.0);
}

double clamp_dispatch(double value, double limit) {
  return std::clamp(value, -limit, limit);
}

void write_audit_log(const DispatchFrame&, std::int64_t) {
}

void raise_alarm(DispatchFrame& frame) {
  frame.alarm = true;
  write_audit_log(frame, monotonic_time_ms());
}

DispatchFrame read_bus_snapshot() {
  DispatchFrame frame = allocate_frame();
  frame.bus_loads = {42.0, 31.0, 28.0, 19.0};
  return frame;
}

bool validate_measurements(DispatchFrame& frame) {
  const double normalized_voltage = normalize_samples(frame.voltage / 900.0);
  if (normalized_voltage < 0.65) {
    raise_alarm(frame);
    return false;
  }
  return true;
}

double estimate_demand(const DispatchFrame& frame) {
  double total = 0.0;
  for (double load : frame.bus_loads) total += load;
  return total * normalize_samples(frame.voltage / 800.0);
}

double forecast_storage(const DispatchFrame& frame) {
  const ControlConfig config = load_control_config();
  return std::max(0.0, frame.storage_state - config.storage_reserve);
}

void allocate_bus_targets(DispatchFrame& frame, double demand, double storage) {
  const double distributable = clamp_dispatch(demand - storage * 0.15, 120.0);
  frame.targets = {distributable * 0.34, distributable * 0.28,
                   distributable * 0.23, distributable * 0.15};
}

bool check_thermal_limit(DispatchFrame& frame) {
  if (frame.temperature > 78.0) {
    raise_alarm(frame);
    return false;
  }
  return true;
}

bool check_voltage_limit(DispatchFrame& frame) {
  if (frame.voltage < 620.0 || frame.voltage > 840.0) {
    raise_alarm(frame);
    return false;
  }
  return true;
}

void apply_safety_derate(DispatchFrame& frame) {
  for (double& target : frame.targets) target = clamp_dispatch(target * 0.72, 36.0);
}

void persist_command(const DispatchFrame&, std::int64_t) {
}

void emit_control_event(const DispatchFrame&, std::int64_t) {
}

void enqueue_dispatch(const DispatchFrame& frame) {
  persist_command(frame, monotonic_time_ms());
}

void publish_telemetry(const DispatchFrame& frame) {
  emit_control_event(frame, monotonic_time_ms());
}

int run_dispatch_cycle(std::int64_t now_ms) {
  const ControlConfig config = load_control_config();
  DispatchFrame frame = read_bus_snapshot();
  if (!validate_measurements(frame)) return -1;

  const double demand = estimate_demand(frame);
  const double storage = forecast_storage(frame);
  allocate_bus_targets(frame, std::min(demand, config.demand_limit), storage);

  const bool thermal_ok = check_thermal_limit(frame);
  const bool voltage_ok = check_voltage_limit(frame);
  if (!thermal_ok || !voltage_ok) apply_safety_derate(frame);

  enqueue_dispatch(frame);
  publish_telemetry(frame);
  write_audit_log(frame, now_ms);
  return frame.alarm ? 1 : 0;
}

int demo_entry() {
  return run_dispatch_cycle(monotonic_time_ms());
}

}  // namespace EnergyDispatchDemo
