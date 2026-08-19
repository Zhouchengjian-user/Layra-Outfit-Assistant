const cities: Record<string, [number, number]> = {
  杭州: [30.2741, 120.1551], 上海: [31.2304, 121.4737], 北京: [39.9042, 116.4074],
  广州: [23.1291, 113.2644], 深圳: [22.5431, 114.0579], 成都: [30.5728, 104.0668],
};

function weatherText(code: number) {
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "有小雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "有雪";
  if ([95, 96, 99].includes(code)) return "雷阵雨";
  if ([1, 2, 3, 45, 48].includes(code)) return "多云";
  return "晴朗";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = (url.searchParams.get("city") || "杭州").slice(0, 12);
  const fallback = cities[city] || cities.杭州;
  const latitude = Number(url.searchParams.get("lat")) || fallback[0];
  const longitude = Number(url.searchParams.get("lon")) || fallback[1];
  try {
    const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
    endpoint.searchParams.set("latitude", String(latitude));
    endpoint.searchParams.set("longitude", String(longitude));
    endpoint.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m");
    endpoint.searchParams.set("timezone", "Asia/Shanghai");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("天气服务暂不可用");
    const payload = await response.json() as { current?: Record<string, number> };
    const current = payload.current || {};
    const temperature = Math.round(current.temperature_2m ?? 24);
    const apparent = Math.round(current.apparent_temperature ?? temperature);
    return Response.json({ city, temperature, apparent, condition: weatherText(current.weather_code ?? 0), precipitation: current.precipitation ?? 0, wind: current.wind_speed_10m ?? 0, source: "live" });
  } catch {
    return Response.json({ city, temperature: 24, apparent: 25, condition: "多云", precipitation: 0, wind: 8, source: "fallback" });
  }
}
