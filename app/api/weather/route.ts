const cities: Record<string, [number, number]> = {
  北京: [39.9042, 116.4074], 上海: [31.2304, 121.4737], 广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579], 杭州: [30.2741, 120.1551], 成都: [30.5728, 104.0668],
  南京: [32.0603, 118.7969], 武汉: [30.5928, 114.3055], 西安: [34.3416, 108.9398],
  重庆: [29.563, 106.5516], 天津: [39.3434, 117.3616], 苏州: [31.2989, 120.5853],
  长沙: [28.2282, 112.9388], 青岛: [36.0671, 120.3826], 厦门: [24.4798, 118.0894],
  郑州: [34.7466, 113.6254], 沈阳: [41.8057, 123.4315], 大连: [38.914, 121.6147],
  济南: [36.6512, 117.1201], 福州: [26.0745, 119.2965], 昆明: [25.0389, 102.7183],
  合肥: [31.8206, 117.2272], 南昌: [28.682, 115.8579], 贵阳: [26.647, 106.6302],
};

function nearestCity(lat: number, lon: number): string {
  let best = "杭州";
  let bestDist = Infinity;
  for (const [name, [clat, clon]] of Object.entries(cities)) {
    const dist = (lat - clat) ** 2 + (lon - clon) ** 2;
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return best;
}

function weatherText(code: number) {
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "有小雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "有雪";
  if ([95, 96, 99].includes(code)) return "雷阵雨";
  if ([1, 2, 3, 45, 48].includes(code)) return "多云";
  return "晴朗";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedCity = (url.searchParams.get("city") || "").slice(0, 12);
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));
  const hasGeo = Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0);

  let city = requestedCity || "杭州";
  const fallback = cities[city] || cities.杭州;
  const lat = hasGeo ? latitude : fallback[0];
  const lon = hasGeo ? longitude : fallback[1];

  // 定位（传经纬度但没传城市名）时，就近匹配预设城市名。
  if (hasGeo && !requestedCity) {
    city = nearestCity(lat, lon);
  }

  try {
    const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
    endpoint.searchParams.set("latitude", String(lat));
    endpoint.searchParams.set("longitude", String(lon));
    endpoint.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
    endpoint.searchParams.set("timezone", "Asia/Shanghai");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("天气服务暂不可用");
    const payload = await response.json() as { current?: Record<string, number> };
    const current = payload.current || {};
    const temperature = Math.round(current.temperature_2m ?? 24);
    const apparent = Math.round(current.apparent_temperature ?? temperature);
    return Response.json({
      city,
      temperature,
      apparent,
      condition: weatherText(current.weather_code ?? 0),
      precipitation: current.precipitation ?? 0,
      wind: current.wind_speed_10m ?? 0,
      source: "live",
    });
  } catch {
    return Response.json({ city, temperature: 24, apparent: 25, condition: "多云", precipitation: 0, wind: 8, source: "fallback" });
  }
}
