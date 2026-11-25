class MetricsRegistry {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string | number> = {}, delta = 1) {
    const key = this.formatKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + delta);
  }

  private formatKey(name: string, labels: Record<string, string | number>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    const labelStr = entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
    return `${name}{${labelStr}}`;
  }

  toPrometheusText(gauges: Record<string, number>): string {
    const lines: string[] = [
      '# HELP landconnect_uptime_seconds Process uptime in seconds',
      '# TYPE landconnect_uptime_seconds gauge',
      `landconnect_uptime_seconds ${Math.floor(process.uptime())}`,
    ];

    for (const [k, v] of Object.entries(gauges)) {
      lines.push(`# TYPE ${k} gauge`);
      lines.push(`${k} ${v}`);
    }

    for (const [k, v] of this.counters.entries()) {
      lines.push(`${k} ${v}`);
    }
    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();
