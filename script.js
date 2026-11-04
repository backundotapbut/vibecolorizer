(function () {
    'use strict';

    const ADDON_NAME = 'VibeColorizer';
    const VERSION = '4.5.0';

    const CSS_COLORS_VAR = '--pulsesync-vibe-custom-colors';
    const CSS_PRIMARY_VAR = '--pulsesync-vibe-primary-hsl';
    const CSS_PATCH_DETECT_VAR = '--pulsesync-vibe-patch-active';

    const STOP_PRIORITY = ['topStart', 'middleStart', 'bottomStart', 'topEnd', 'middleEnd', 'bottomEnd'];

    const WARM_HUE_RANGE = { start: 15, end: 60 };
    const GREEN_HUE_RANGE = { start: 60, end: 180 };
    const NEUTRAL_SAT_THRESHOLD = 0.12;
    const BLACK_LIGHTNESS_MAX = 0.05;

    let DEBUG = false;

    function log(...args) { console.log(`[${ADDON_NAME}]`, ...args); }
    function warn(...args) { console.warn(`[${ADDON_NAME}]`, ...args); }
    function debug(...args) { if (DEBUG) console.log(`%c[${ADDON_NAME} DEBUG]`, 'color:#00bfff;font-weight:bold', ...args); }

    const DEFAULTS = {
        patchInstalled: false,
        colorMode: 'auto',
        restoreOnPause: true,

        enabled: true,
        colorCount: 6,
        colorAlgorithm: 'huePriority',
        sortBy: 'weight',
        saturationThreshold: 0.05,
        lightnessMin: 0.03,
        lightnessMax: 0.98,
        quantizationLevel: 8,
        clusterThreshold: 30,
        hueRotation: 0,
        saturationBoost: 1.1,
        lightnessBoost: 1.0,
        transitionDuration: 0.5,
        debug: false,

        monotoneEnabled: false,
        monotoneMethod: 'default',
        monotoneIntensity: 0.85,
        monotoneSaturation: 1.0,
        monotoneBrightness: 1.0,
        monotoneAdaptiveBrightness: true,
        monotoneSpecialNeutralHandling: true,
        monotoneSaturationPreference: 0.7,
        fullHueIntensity: true,

        legacyMode: 'auto',
        preloadCovers: true,
        maxCacheSize: 120,
        disableGradient: true,
    };

    let settings = { ...DEFAULTS };
    let isReady = false;
    let currentTrackId = null;
    let processingTrackId = null;
    let applyToken = 0;
    let patchDetected = null;

    const coverCache = new Map();
    const preloadQueue = new Set();

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                default: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h: h * 360, s, l };
    }

    function hslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360;
        s = Math.max(0, Math.min(1, s));
        l = Math.max(0, Math.min(1, l));
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
    }

    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
    function normalizeHue(h) { const v = h % 360; return v < 0 ? v + 360 : v; }
    function colorToCss(c) { return `hsl(${Math.round(c.h)}, ${Math.round(c.s * 100)}%, ${Math.round(c.l * 100)}%)`; }
    function round(v, p = 3) { const f = Math.pow(10, p); return Math.round(v * f) / f; }

    function inHueRange(h, range) {
        const nh = normalizeHue(h);
        return range.start <= range.end ? nh >= range.start && nh <= range.end : nh >= range.start || nh <= range.end;
    }

    function huePriorityScore(entry) {
        const { h, s, l, frequency } = entry;
        if (l <= BLACK_LIGHTNESS_MAX) return -Infinity;
        let hueBoost = inHueRange(h, WARM_HUE_RANGE) ? 2.5 : inHueRange(h, GREEN_HUE_RANGE) ? 1.2 : 0.5;
        const satWeight = s > NEUTRAL_SAT_THRESHOLD ? 1 + s * 1.5 : 0.6;
        const freqWeight = Math.sqrt(frequency) * 0.8;
        return (0.5 + hueBoost) * satWeight * (1 + freqWeight);
    }

    function saturationFirstScore(entry) {
        const { s, l, frequency } = entry;
        if (l <= BLACK_LIGHTNESS_MAX) return -Infinity;
        return s * (1 + Math.sqrt(frequency));
    }

    function frequencyScore(entry) {
        const { frequency, s, l } = entry;
        if (l <= BLACK_LIGHTNESS_MAX) return -Infinity;
        return frequency * (0.3 + s * 0.7);
    }

    function weightedScore(entry) {
        const { frequency, s, l } = entry;
        if (l <= BLACK_LIGHTNESS_MAX) return -Infinity;
        return frequency * (0.5 + s * 0.5);
    }

    function clusterScore(entry) {
        const { frequency, s, l, count } = entry;
        if (l <= BLACK_LIGHTNESS_MAX) return -Infinity;
        return count * (0.4 + s * 0.6);
    }

    const SCORING_FNS = {
        huePriority: huePriorityScore,
        saturation: saturationFirstScore,
        frequency: frequencyScore,
        weight: weightedScore,
        cluster: clusterScore,
    };

    function getImagePixels(image, size) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        canvas.width = size; canvas.height = size;
        ctx.drawImage(image, 0, 0, size, size);
        try { return ctx.getImageData(0, 0, size, size).data; }
        catch (e) { warn('CORS error reading cover:', e); return null; }
    }

    function quantizeChannel(v, step) { return Math.min(255, Math.floor(v / step) * step + step / 2); }

    function extractDominantColors(image) {
        const size = 160;
        const pixels = getImagePixels(image, size);
        if (!pixels) return [];

        const level = clamp(Math.round(settings.quantizationLevel), 4, 16);
        const step = 256 / level;
        const histogram = new Map();
        let accepted = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            const a = pixels[i + 3];
            if (a < 125) continue;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            const hsl = rgbToHsl(r, g, b);

            if (hsl.s < settings.saturationThreshold) continue;
            if (hsl.l < settings.lightnessMin || hsl.l > settings.lightnessMax) continue;
            if (hsl.l <= BLACK_LIGHTNESS_MAX) continue;

            const key = `${quantizeChannel(r, step)},${quantizeChannel(g, step)},${quantizeChannel(b, step)}`;
            const bucket = histogram.get(key);
            if (bucket) {
                bucket.count++; bucket.sumR += r; bucket.sumG += g; bucket.sumB += b;
            } else {
                histogram.set(key, { count: 1, sumR: r, sumG: g, sumB: b });
            }
            accepted++;
        }

        if (accepted === 0) { debug('All pixels filtered'); return []; }

        const entries = [];
        const scoreFn = SCORING_FNS[settings.colorAlgorithm] || SCORING_FNS.huePriority;
        for (const bucket of histogram.values()) {
            const r = bucket.sumR / bucket.count;
            const g = bucket.sumG / bucket.count;
            const b = bucket.sumB / bucket.count;
            const hsl = rgbToHsl(r, g, b);
            const freq = bucket.count / accepted;
            const weight = scoreFn({ h: hsl.h, s: hsl.s, l: hsl.l, frequency: freq, count: bucket.count });
            entries.push({ h: hsl.h, s: hsl.s, l: hsl.l, frequency: freq, count: bucket.count, weight });
        }

        entries.sort((a, b) => b.weight - a.weight);

        const clusters = [];
        const hueThr = clamp(settings.clusterThreshold, 5, 180);
        for (const e of entries) {
            let merged = false;
            for (const c of clusters) {
                const dh = Math.min(Math.abs(e.h - c.h), 360 - Math.abs(e.h - c.h));
                if (dh <= hueThr && Math.abs(e.s - c.s) <= 0.25 && Math.abs(e.l - c.l) <= 0.25) {
                    const tot = c.count + e.count;
                    c.h = (c.h * c.count + e.h * e.count) / tot;
                    c.s = (c.s * c.count + e.s * e.count) / tot;
                    c.l = (c.l * c.count + e.l * e.count) / tot;
                    c.count = tot;
                    c.frequency = c.count / accepted;
                    c.weight = scoreFn({ h: c.h, s: c.s, l: c.l, frequency: c.frequency, count: c.count });
                    merged = true; break;
                }
            }
            if (!merged) clusters.push({ ...e });
        }

        clusters.sort((a, b) => b.weight - a.weight);
        const cnt = clamp(Math.round(settings.colorCount), 1, 6);
        const res = clusters.slice(0, cnt);
        debug(`Extracted ${res.length} colors from ${accepted}px`);
        res.forEach((c, i) => debug(`  ${i+1}. ${colorToCss(c)} w=${c.weight.toFixed(4)}`));
        return res;
    }

    function prepareColor(c) {
        if (!c || !Number.isFinite(c.h) || !Number.isFinite(c.s) || !Number.isFinite(c.l)) {
            debug('prepareColor: invalid input color', c);
            return { h: 0, s: 0, l: 0.5 };
        }
        const hueRot = Number.isFinite(settings.hueRotation) ? settings.hueRotation : 0;
        const satBoost = Number.isFinite(settings.saturationBoost) ? settings.saturationBoost : 1;
        const lightBoost = Number.isFinite(settings.lightnessBoost) ? settings.lightnessBoost : 1;
        return {
            h: normalizeHue(c.h + hueRot),
            s: clamp(c.s * satBoost, 0, 1),
            l: clamp(c.l * lightBoost, 0, 1),
        };
    }

    function mapColorsToStops(colors) {
        if (!colors?.length) return null;
        const six = {};
        if (colors.length === 1) {
            const c = prepareColor(colors[0]);
            STOP_PRIORITY.forEach(s => six[s] = { ...c });
            return six;
        }
        if (colors.length === 2) {
            const a = prepareColor(colors[0]), b = prepareColor(colors[1]);
            six.topStart = six.topEnd = six.bottomStart = six.bottomEnd = { ...a };
            six.middleStart = six.middleEnd = { ...b };
            return six;
        }
        if (colors.length === 3) {
            six.topStart = six.topEnd = prepareColor(colors[0]);
            six.middleStart = six.middleEnd = prepareColor(colors[1]);
            six.bottomStart = six.bottomEnd = prepareColor(colors[2]);
            return six;
        }
        for (let i = 0; i < STOP_PRIORITY.length; i++) {
            six[STOP_PRIORITY[i]] = prepareColor(colors[Math.min(i, colors.length - 1)]);
        }
        return six;
    }

    // ─── Monotone algorithms (ported from old addon) ─────────────────────────
    function extractMonotoneDefault(img) {
        const data = getImageData(img);
        if (!data) return null;
        const pref = settings.monotoneSaturationPreference || 0.7;
        const pixels = [];
        const step = 2;
        for (let i = 0; i < data.length; i += step * 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            const { s, l } = rgbToHsl(r, g, b);
            if (l < 0.03 || l > 0.97 || s < 0.05) continue;
            pixels.push({ r, g, b, s, l });
        }
        if (!pixels.length) return avgFallback(data);
        pixels.sort((a, b) => b.s - a.s);
        const topPct = 0.05 + pref * 0.75;
        const topN = Math.max(1, Math.floor(pixels.length * topPct));
        const top = pixels.slice(0, topN);
        let r=0,g=0,b=0; for (const p of top) { r+=p.r; g+=p.g; b+=p.b; }
        let color = { r: r/topN|0, g: g/topN|0, b: b/topN|0 };
        const hsl = rgbToHsl(color.r, color.g, color.b);
        if (hsl.l < 0.15 && hsl.s > 0.1) {
            const nl = Math.min(hsl.l * 1.8, 0.5);
            const rgb = hslToRgb(hsl.h, hsl.s, nl);
            color = { r: rgb.r, g: rgb.g, b: rgb.b };
        }
        return color;
    }

    function extractMonotoneAlternative(img) {
        const data = getImageData(img);
        if (!data) return null;
        const bal = settings.monotoneSaturationPreference || 0.7;
        const levels = 16, quant = 256/levels;
        const hist = new Map(); let tot = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            const { l } = rgbToHsl(r, g, b);
            if (l < 0.03 || l > 0.97) continue;
            const k = `${Math.floor(r/quant)},${Math.floor(g/quant)},${Math.floor(b/quant)}`;
            hist.set(k, (hist.get(k)||0)+1); tot++;
        }
        if (!tot) return avgFallback(data);
        let bestK=null, bestS=-Infinity;
        for (const [k, cnt] of hist) {
            const freq = cnt/tot;
            const [rq,gq,bq] = k.split(',').map(Number);
            const r = Math.round((rq+0.5)*quant), g = Math.round((gq+0.5)*quant), b = Math.round((bq+0.5)*quant);
            const { s } = rgbToHsl(r, g, b);
            const sc = freq*(1-bal) + s*bal;
            if (sc > bestS) { bestS=sc; bestK=k; }
        }
        if (!bestK) return null;
        const [rq,gq,bq] = bestK.split(',').map(Number);
        return { r: Math.round((rq+0.5)*quant), g: Math.round((gq+0.5)*quant), b: Math.round((bq+0.5)*quant) };
    }

    function extractMonotoneBalanced(img) {
        const data = getImageData(img);
        if (!data) return null;
        const pref = settings.monotoneSaturationPreference || 0.7;
        const pix = [];
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2];
            const hsl = rgbToHsl(r, g, b);
            if (hsl.l < 0.08 || hsl.l > 0.92 || hsl.s < 0.05) continue;
            pix.push({ r, g, b, h: hsl.h, s: hsl.s, l: hsl.l });
        }
        if (!pix.length) return avgFallback(data);
        const step = 15;
        const groups = new Map();
        for (const p of pix) {
            const b = Math.floor(p.h/step)*step;
            if (!groups.has(b)) groups.set(b, []);
            groups.get(b).push(p);
        }
        let bestB=null, bestS=-Infinity;
        for (const [b, arr] of groups) {
            const freq = arr.length/pix.length;
            const avgS = arr.reduce((s,p)=>s+p.s,0)/arr.length;
            const sc = freq*(1-pref) + avgS*pref;
            if (sc > bestS) { bestS=sc; bestB=b; }
        }
        const best = groups.get(bestB);
        let r=0,g=0,b=0; for (const p of best) { r+=p.r; g+=p.g; b+=p.b; }
        let color = { r: r/best.length|0, g: g/best.length|0, b: b/best.length|0 };
        const hsl = rgbToHsl(color.r, color.g, color.b);
        if (hsl.l < 0.25) {
            const nl = Math.min(hsl.l*1.6, 0.5);
            const rgb = hslToRgb(hsl.h, hsl.s, nl);
            color = { r: rgb.r, g: rgb.g, b: rgb.b };
        }
        return color;
    }

    function avgFallback(data) {
        let r=0,g=0,b=0,c=0;
        for (let i=0;i<data.length;i+=64){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; c++; }
        return { r: r/c|0, g: g/c|0, b: b/c|0 };
    }

    function getImageData(img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const size = 100;
        canvas.width = size; canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size).data;
    }

    function extractMonotoneColor(img) {
        const m = settings.monotoneMethod || 'default';
        switch (m) {
            case 'balanced': return extractMonotoneBalanced(img);
            case 'alternative': return extractMonotoneAlternative(img);
            default: return extractMonotoneDefault(img);
        }
    }

    // ─── Legacy filter mode (EXACT port from old addon) ───────────────────────────
    let cachedBaseWaveColor = null;
    let baseColorCaptureAttempted = false;

    function captureBaseWaveColor() {
        if (baseColorCaptureAttempted) return cachedBaseWaveColor;
        baseColorCaptureAttempted = true;

        try {
            const root = getLegacyRootElement();
            if (!root) {
                debug('Base color capture: root not found');
                return null;
            }
            // Read the ORIGINAL color ONCE at startup (before any filters)
            const colorStr = getComputedStyle(root).getPropertyValue('--vibe-gradient-stop-0').trim();
            if (!colorStr) {
                debug('Base color capture: variable empty');
                return null;
            }
            const rgbMatch = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
            if (!rgbMatch) {
                debug('Base color capture: failed to parse', colorStr);
                return null;
            }
            const rgb = { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3] };
            cachedBaseWaveColor = rgb;
            debug('Base color CAPTURED at startup:', rgb, 'hsl:', rgbToHsl(rgb.r, rgb.g, rgb.b));
            return rgb;
        } catch (e) {
            debug('Base color capture error:', e);
            return null;
        }
    }

    function getBaseWaveColor() {
        if (cachedBaseWaveColor) return cachedBaseWaveColor;
        return captureBaseWaveColor();
    }

    function computeLegacyFilterValues(targetColor) {
        const defaultValues = { hue: 0, saturate: 1, brightness: 1 };
        if (!targetColor) {
            debug('Legacy: targetColor is null');
            return defaultValues;
        }

        // ALWAYS use cached base color (captured ONCE at startup, before any filters)
        const source = getBaseWaveColor();
        if (!source) {
            debug('Legacy: no base color cached, using fallback');
            return defaultValues;
        }

        const sourceHsl = rgbToHsl(source.r, source.g, source.b);
        const targetHsl = rgbToHsl(targetColor.r, targetColor.g, targetColor.b);

        let deltaH = targetHsl.h - sourceHsl.h;
        if (deltaH > 180) deltaH -= 360;
        if (deltaH < -180) deltaH += 360;

        const targetSaturation = targetHsl.s;
        const targetLightness = targetHsl.l;

        const isWhite = targetLightness > 0.9;
        const isBlack = targetLightness < 0.1;
        const isNeutral = targetSaturation < 0.1 && !isWhite && !isBlack;

        debug('Legacy: ΔH:', deltaH, 'Category:', isWhite ? 'WHITE' : isBlack ? 'BLACK' : isNeutral ? 'NEUTRAL' : 'NORMAL');
        debug('Legacy: sourceH (BASE):', sourceHsl.h.toFixed(1), 'targetH:', targetHsl.h.toFixed(1), 'deltaH:', deltaH.toFixed(1));

        let finalHue = 0;
        let finalBright = settings.monotoneBrightness;
        let finalSaturate = settings.monotoneSaturation;

        const absDelta = Math.abs(deltaH);
        let intensity = settings.monotoneIntensity;
        
        // fullHueIntensity = true: не снижать intensity для hue (точный цвет)
        // fullHueIntensity = false: старая логика сглаживания для больших дельт
        if (!settings.fullHueIntensity) {
            if (absDelta < 15) {
                intensity *= (absDelta / 15);
            } else if (absDelta < 30) {
                intensity *= 0.5;
            }
        }

        if (settings.monotoneAdaptiveBrightness) {
            const deltaLightness = (targetLightness - 0.5) * 0.8;
            if (targetLightness > 0.5) {
                const brightnessBoost = Math.min(2.0, finalBright + deltaLightness);
                finalBright = Math.min(2.0, brightnessBoost);
                const satReduction = (targetLightness - 0.5) * 0.6;
                finalSaturate = Math.max(0.1, finalSaturate * (1 - satReduction));
            } else {
                const darkFactor = 1 - (targetLightness / 0.5);
                finalBright = Math.max(0.5, finalBright - darkFactor * 0.5);
                finalSaturate = Math.max(0.1, finalSaturate * (1 - darkFactor * 0.3));
            }
        }

        if (isWhite) {
            if (settings.monotoneSpecialNeutralHandling) {
                finalBright = Math.min(2.0, settings.monotoneBrightness + 0.3);
                finalSaturate = Math.min(0.1, settings.monotoneSaturation * 0.1);
                finalHue = 0;
            } else return defaultValues;
        } else if (isBlack) {
            if (settings.monotoneSpecialNeutralHandling) {
                finalBright = Math.max(0.4, settings.monotoneBrightness * 0.5);
                finalSaturate = 0.1;
                finalHue = 0;
            } else return defaultValues;
        } else if (isNeutral) {
            if (settings.monotoneSpecialNeutralHandling) {
                finalBright = Math.min(1.6, Math.max(0.6, settings.monotoneBrightness * (0.8 + targetLightness * 0.4)));
                finalSaturate = Math.min(0.1, settings.monotoneSaturation * 0.1);
                finalHue = (absDelta > 5 && absDelta < 45) ? deltaH * 0.1 : 0;
            } else return defaultValues;
        } else {
            finalHue = deltaH * intensity;
        }

        finalHue = Math.min(360, Math.max(-360, finalHue));
        finalBright = Math.min(2.0, Math.max(0.4, finalBright));
        finalSaturate = Math.min(1.5, Math.max(0.1, finalSaturate));

        debug('Legacy: final filter:', { hue: finalHue, saturate: finalSaturate, brightness: finalBright });
        return { hue: finalHue, saturate: finalSaturate, brightness: finalBright };
    }

    function applyLegacyFilterDirect(values) {
        const canvas = getLegacyCanvas();
        if (!canvas) {
            debug('Legacy: applyFilterDirect - canvas not found');
            return;
        }
        
        // СНАЧАЛА сбрасываем старый фильтр БЕЗ перехода
        canvas.style.transition = 'none';
        canvas.style.filter = 'none';
        void canvas.offsetHeight; // форсируем reflow
        
        // ПОТОМ применяем новый фильтр С переходом
        const duration = settings.transitionDuration || 0.6;
        canvas.style.transition = `filter ${duration}s linear`;
        void canvas.offsetHeight;
        canvas.style.filter = `hue-rotate(${values.hue}deg) saturate(${values.saturate}) brightness(${values.brightness})`;
        debug('Legacy: filter applied', values);
    }

    function applyLegacyMode(stops) {
        if (!stops) return;
        const primary = stops.topStart;
        if (!primary || !Number.isFinite(primary.h) || !Number.isFinite(primary.s) || !Number.isFinite(primary.l)) {
            debug('Legacy: invalid primary color', primary);
            return;
        }
        const targetRgb = hslToRgb(primary.h, primary.s, primary.l);
        debug('Legacy: target RGB', targetRgb);
        const filterValues = computeLegacyFilterValues(targetRgb);
        applyLegacyFilterDirect(filterValues);
    }

    let legacyWaveObserver = null;
    function startLegacyWaveObserver() {
        if (legacyWaveObserver) return;
        const root = getLegacyRootElement();
        if (!root) {
            setTimeout(startLegacyWaveObserver, 500);
            return;
        }

        legacyWaveObserver = new MutationObserver(() => {
            requestAnimationFrame(() => {
                if (settings.enabled && !settings.monotoneEnabled && !patchDetected) {
                    handleTrackChange(true);
                } else if (settings.enabled && settings.monotoneEnabled && !patchDetected) {
                    const track = window.pulsesyncApi?.getCurrentTrack?.();
                    if (track) {
                        const url = getCoverUrl(track);
                        if (url && coverCache.has(url)) {
                            const colors = coverCache.get(url);
                            if (colors && colors.length) {
                                const stops = mapColorsToStops(colors);
                                applyLegacyMode(stops);
                            }
                        }
                    }
                }
            });
        });
        legacyWaveObserver.observe(root, {
            attributes: true,
            attributeFilter: ['style', 'class']
        });
        debug('Legacy: wave color observer started');
    }

    // ─── Gradient transparency (disable gradient background) ───────────────────
    function getGradientRoot() {
        return document.querySelector('.CommonLayout_root__WC_W1') ||
               document.querySelector('[class*="CommonLayout_root"]');
    }

    let gradientObserver = null;
    function applyGradientState() {
        const root = getGradientRoot();
        if (!root) {
            debug('Gradient: root element not found');
            return;
        }

        if (settings.disableGradient) {
            root.style.setProperty('background', 'transparent', 'important');
            debug('Gradient: disabled (background transparent)');
            startGradientObserver();
        } else {
            root.style.removeProperty('background');
            debug('Gradient: restored');
            stopGradientObserver();
        }
    }

    function startGradientObserver() {
        if (gradientObserver) return;
        const root = getGradientRoot();
        if (!root) return;

        gradientObserver = new MutationObserver(() => {
            if (settings.disableGradient) {
                const computedBg = getComputedStyle(root).background;
                if (computedBg !== 'rgba(0, 0, 0, 0)' && computedBg !== 'transparent') {
                    root.style.setProperty('background', 'transparent', 'important');
                    debug('Gradient: forcibly restored transparent background');
                }
            }
        });

        gradientObserver.observe(root, {
            attributes: true,
            attributeFilter: ['style']
        });
        debug('Gradient: observer started');
    }

    function stopGradientObserver() {
        if (gradientObserver) {
            gradientObserver.disconnect();
            gradientObserver = null;
            debug('Gradient: observer stopped');
        }
    }

    // ─── Patch detection ─────────────────────────────────────────────────────
    function detectPatch() {
        // 1. Manual override from settings (highest priority)
        if (settings.patchInstalled === true) return true;
        if (settings.patchInstalled === false) return false;

        // 2. Auto-detect (fallback)
        try {
            const val = document.documentElement.style.getPropertyValue(CSS_PATCH_DETECT_VAR).trim();
            if (val === '1') return true;

            const inlineScripts = document.querySelectorAll('script:not([src])');
            for (const s of inlineScripts) {
                const text = s.textContent || '';
                if (text.includes('__psVibeColorsRaw')) {
                    return true;
                }
            }
            if (window.__PULSESYNC_VIBE_PATCH_ACTIVE === true) return true;
        } catch { return false; }
        return false;
    }

    function serializeStops(stops) {
        const r = {};
        for (const s of STOP_PRIORITY) {
            const c = stops[s];
            if (!c || !Number.isFinite(c.h) || !Number.isFinite(c.s) || !Number.isFinite(c.l)) {
                debug('Invalid color for stop', s, c);
                r[s] = { h: 0, s: 0, l: 0.5 };
            } else {
                r[s] = { h: round(c.h,2), s: round(c.s,3), l: round(c.l,3) };
            }
        }
        return r;
    }

    function dispatchWaveUpdate() {
        try {
            window.dispatchEvent(new CustomEvent('pulse-sync-vibe-setting-change', {
                detail: { key: 'modSettings.vibeAnimationEnhancement.useVibeWidgetColors', value: false }
            }));
            debug('Wave update event sent');
        } catch (e) { warn('Event dispatch failed:', e); }
    }

    function setWaveColors(stops) {
        const ser = serializeStops(stops);
        const prim = ser.topStart;
        document.documentElement.style.setProperty(CSS_COLORS_VAR, JSON.stringify(ser));
        document.documentElement.style.setProperty(CSS_PRIMARY_VAR, JSON.stringify({h:prim.h,s:prim.s,l:prim.l}));
        debug('CSS vars set', ser);
    }

    function clearWaveColors() {
        document.documentElement.style.removeProperty(CSS_COLORS_VAR);
        document.documentElement.style.removeProperty(CSS_PRIMARY_VAR);
    }

    function applyWaveColors(trackId) {
        const tok = ++applyToken;
        const delays = [0, 120, 400, 900, 1800];
        for (const d of delays) setTimeout(() => {
            if (tok !== applyToken) return;
            if (trackId && String(currentTrackId) !== String(trackId)) return;
            dispatchWaveUpdate();
        }, d);
    }

    // ─── Cover loading & cache ───────────────────────────────────────────────
    function getCoverUrl(track) {
        if (!track?.coverUri) return null;
        let u = String(track.coverUri).replace(/%%/g, '400x400');
        if (!/^https?:\/\//.test(u)) u = 'https://' + u;
        return u;
    }

    function loadColorsForTrack(track, cb) {
        const url = getCoverUrl(track);
        if (!url) { debug('No cover'); cb(null); return; }
        if (coverCache.has(url)) { debug('Cache hit'); cb(coverCache.get(url)); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        let done = false;
        const finish = (cols) => {
            if (done) return; done = true;
            if (cols?.length) {
                if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                coverCache.set(url, cols);
            }
            cb(cols?.length ? cols : null);
        };
        img.onload = () => { try { finish(extractDominantColors(img)); } catch(e){ warn('Extract err',e); finish(null); } };
        img.onerror = () => { warn('Cover load failed:',url); finish(null); };
        img.src = url;
    }

    function preloadCover(track) {
        if (!settings.preloadCovers) return;
        const url = getCoverUrl(track);
        if (!url || coverCache.has(url) || preloadQueue.has(url)) return;
        preloadQueue.add(url);
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            preloadQueue.delete(url);
            try {
                const cols = extractDominantColors(img);
                if (cols?.length) {
                    if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                    coverCache.set(url, cols);
                    debug('Preloaded:', url);
                }
            } catch(e) { warn('Preload extract err:', e); }
        };
        img.onerror = () => preloadQueue.delete(url);
        img.src = url;
    }

    // ─── Track processing ────────────────────────────────────────────────────
    function processTrack(track, force=false) {
        if (!settings.enabled || !track) return;
        const id = String(track.id);
        if (!force && id === currentTrackId) return;
        if (processingTrackId === id) return;
        currentTrackId = id; processingTrackId = id;
        debug(`Process: ${track.title} - ${track.artists?.[0]?.name}`);

        loadColorsForTrack(track, (colors) => {
            processingTrackId = null;
            if (String(currentTrackId) !== id) { debug('Track changed mid-load'); return; }
            if (!colors) { 
                debug('No colors extracted, trying fallback average color');
                const url = getCoverUrl(track);
                if (url) {
                    const img = new Image();
                    img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
                    img.onload = () => {
                        const fallback = getAverageColor(img);
                        if (fallback) {
                            const stops = mapColorsToStops([fallback]);
                            applyColorsByMode(stops, id);
                        }
                    };
                    img.src = url;
                }
                return; 
            }

            const stops = mapColorsToStops(colors);
            log(`Palette: ${colors.length} colors, main ${colorToCss(colors[0])}`);
            applyColorsByMode(stops, id);
        });
    }

    function getAverageColor(img) {
        const data = getImageData(img);
        if (!data) return null;
        let r=0,g=0,b=0,c=0;
        for (let i=0;i<data.length;i+=64){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; c++; }
        const avgR = r/c|0, avgG = g/c|0, avgB = b/c|0;
        const hsl = rgbToHsl(avgR, avgG, avgB);
        if (hsl.l < 0.15) {
            const rgb = hslToRgb(hsl.h, hsl.s, 0.4);
            return { h: hsl.h, s: hsl.s, l: 0.4 };
        }
        return { h: hsl.h, s: hsl.s, l: hsl.l };
    }

    function applyColorsByMode(stops, trackId) {
        // Determine effective mode
        let effectiveMulti = false;
        if (settings.colorMode === 'multi') {
            effectiveMulti = true;
        } else if (settings.colorMode === 'mono') {
            effectiveMulti = false;
        } else { // 'auto'
            effectiveMulti = settings.patchInstalled === true;
        }

        const hasPatch = patchDetected;

        if (effectiveMulti && hasPatch) {
            // Multi-color mode with patch - use CSS variables (6 stops)
            setWaveColors(stops);
            applyWaveColors(trackId);
        } else if (effectiveMulti && !hasPatch) {
            // Multi-color requested but no patch - fallback to mono via legacy
            warn('Multi-color mode requires patch-vibe-colors.js. Falling back to mono (legacy).');
            applyLegacyMode(stops);
        } else {
            // Mono mode - always use legacy filters (1 color)
            applyLegacyMode(stops);
        }
    }

    // ─── Pause handling ──────────────────────────────────────────────────────
    let wasPlaying = null;
    let pauseCheckTimer = null;

    function getPlayState() {
        try {
            const api = window.pulsesyncApi;
            if (api?.isPlaying) {
                const result = api.isPlaying();
                if (typeof result === 'boolean') return result;
            }
            // Fallback: check play/pause button in UI
            const pauseBtn = document.querySelector('[data-test-id*="pause"], [aria-label*="пауза" i], [aria-label*="pause" i], [class*="pause" i]');
            const playBtn = document.querySelector('[data-test-id*="play"], [aria-label*="воспроизвед" i], [aria-label*="play" i], [class*="play" i]');
            if (pauseBtn && !pauseBtn.hidden && pauseBtn.offsetParent !== null) return true;
            if (playBtn && !playBtn.hidden && playBtn.offsetParent !== null) return false;
        } catch (e) {}
        return null;
    }

    function clearLegacyFilter() {
        const canvas = getLegacyCanvas();
        if (canvas && canvas.style.filter !== 'none') {
            const dur = settings.transitionDuration || 0.6;
            canvas.style.transition = `filter ${dur}s linear`;
            void canvas.offsetHeight;
            canvas.style.filter = 'none';
            debug('Legacy filter cleared on pause');
        }
    }

    function startPauseWatcher() {
        if (pauseCheckTimer) return;
        
        // Initialize wasPlaying from actual state
        const initialState = getPlayState();
        wasPlaying = initialState === true;
        debug('Pause watcher started, initial playing:', wasPlaying);

        pauseCheckTimer = setInterval(() => {
            if (!settings.enabled || !settings.restoreOnPause) return;
            try {
                const playing = getPlayState();
                if (playing === null) return; // Can't determine state
                
                const nowPlaying = playing === true;
                
                if (wasPlaying === true && nowPlaying === false) {
                    // Just paused - restore default wave colors
                    debug('Pause detected, restoring default wave colors');
                    clearWaveColors();
                    clearLegacyFilter(); // Also clear canvas filter for legacy mode
                    dispatchWaveUpdate();
                    wasPlaying = false;
                } else if (wasPlaying === false && nowPlaying === true) {
                    // Resumed - reapply our colors
                    debug('Resume detected, reapplying colors');
                    wasPlaying = true;
                    handleTrackChange(true);
                }
            } catch (e) {
                // Ignore errors
            }
        }, 500);
    }

    function stopPauseWatcher() {
        if (pauseCheckTimer) {
            clearInterval(pauseCheckTimer);
            pauseCheckTimer = null;
        }
    }

    // ─── Canvas & wave color detection ───────────────────────────────────────
    function getLegacyRootElement() {
        return document.querySelector('.CommonLayout_root__WC_W1') ||
               document.querySelector('[class*="CommonLayout_root"]');
    }

    function getLegacyCanvas() {
        try {
            const root = document.querySelector('[class*="VibePage_root"]');
            if (root) {
                const canvas = root.querySelector('canvas');
                if (canvas) return canvas;
            }
            const anyCanvas = document.querySelector('canvas');
            if (anyCanvas) return anyCanvas;
            const animRoot = document.querySelector('[class*="VibeWidgetAnimation_root"]');
            if (animRoot) {
                const canvas = animRoot.querySelector('canvas');
                if (canvas) return canvas;
            }
        } catch (e) {
            debug('Legacy: error finding canvas', e);
        }
        debug('Legacy: canvas NOT found');
        return null;
    }

    // ─── Cover loading & cache ───────────────────────────────────────────────
    function getCoverUrl(track) {
        if (!track?.coverUri) return null;
        let u = String(track.coverUri).replace(/%%/g, '400x400');
        if (!/^https?:\/\//.test(u)) u = 'https://' + u;
        return u;
    }

    function loadColorsForTrack(track, cb) {
        const url = getCoverUrl(track);
        if (!url) { debug('No cover'); cb(null); return; }
        if (coverCache.has(url)) { debug('Cache hit'); cb(coverCache.get(url)); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        let done = false;
        const finish = (cols) => {
            if (done) return; done = true;
            if (cols?.length) {
                if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                coverCache.set(url, cols);
            }
            cb(cols?.length ? cols : null);
        };
        img.onload = () => { try { finish(extractDominantColors(img)); } catch(e){ warn('Extract err',e); finish(null); } };
        img.onerror = () => { warn('Cover load failed:',url); finish(null); };
        img.src = url;
    }

    function preloadCover(track) {
        if (!settings.preloadCovers) return;
        const url = getCoverUrl(track);
        if (!url || coverCache.has(url) || preloadQueue.has(url)) return;
        preloadQueue.add(url);
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            preloadQueue.delete(url);
            try {
                const cols = extractDominantColors(img);
                if (cols?.length) {
                    if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                    coverCache.set(url, cols);
                    debug('Preloaded:', url);
                }
            } catch(e) { warn('Preload extract err:', e); }
        };
        img.onerror = () => preloadQueue.delete(url);
        img.src = url;
    }

    // ─── Track processing ────────────────────────────────────────────────────
    function processTrack(track, force=false) {
        if (!settings.enabled || !track) return;
        const id = String(track.id);
        if (!force && id === currentTrackId) return;
        if (processingTrackId === id) return;
        currentTrackId = id; processingTrackId = id;
        debug(`Process: ${track.title} - ${track.artists?.[0]?.name}`);

        loadColorsForTrack(track, (colors) => {
            processingTrackId = null;
            if (String(currentTrackId) !== id) { debug('Track changed mid-load'); return; }
            if (!colors) { 
                debug('No colors extracted, trying fallback average color');
                const url = getCoverUrl(track);
                if (url) {
                    const img = new Image();
                    img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
                    img.onload = () => {
                        const fallback = getAverageColor(img);
                        if (fallback) {
                            const stops = mapColorsToStops([fallback]);
                            applyColorsByMode(stops, id);
                        }
                    };
                    img.src = url;
                }
                return; 
            }

            const stops = mapColorsToStops(colors);
            log(`Palette: ${colors.length} colors, main ${colorToCss(colors[0])}`);
            applyColorsByMode(stops, id);
        });
    }

    function getAverageColor(img) {
        const data = getImageData(img);
        if (!data) return null;
        let r=0,g=0,b=0,c=0;
        for (let i=0;i<data.length;i+=64){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; c++; }
        const avgR = r/c|0, avgG = g/c|0, avgB = b/c|0;
        const hsl = rgbToHsl(avgR, avgG, avgB);
        if (hsl.l < 0.15) {
            const rgb = hslToRgb(hsl.h, hsl.s, 0.4);
            return { h: hsl.h, s: hsl.s, l: 0.4 };
        }
        return { h: hsl.h, s: hsl.s, l: hsl.l };
    }

    function applyColorsByMode(stops, trackId) {
        // Determine effective mode
        let effectiveMulti = false;
        if (settings.colorMode === 'multi') {
            effectiveMulti = true;
        } else if (settings.colorMode === 'mono') {
            effectiveMulti = false;
        } else { // 'auto'
            effectiveMulti = settings.patchInstalled === true;
        }

        const hasPatch = patchDetected;

        if (effectiveMulti && hasPatch) {
            // Multi-color mode with patch - use CSS variables (6 stops)
            setWaveColors(stops);
            applyWaveColors(trackId);
        } else if (effectiveMulti && !hasPatch) {
            // Multi-color requested but no patch - fallback to mono via legacy
            warn('Multi-color mode requires patch-vibe-colors.js. Falling back to mono (legacy).');
            applyLegacyMode(stops);
        } else {
            // Mono mode - always use legacy filters (1 color)
            applyLegacyMode(stops);
        }
    }

    // ─── Pause handling ──────────────────────────────────────────────────────

    function getPlayState() {
        try {
            const api = window.pulsesyncApi;
            if (api?.isPlaying) {
                const result = api.isPlaying();
                if (typeof result === 'boolean') return result;
            }
            // Fallback: check play/pause button in UI
            const pauseBtn = document.querySelector('[data-test-id*="pause"], [aria-label*="пауза" i], [aria-label*="pause" i], [class*="pause" i]');
            const playBtn = document.querySelector('[data-test-id*="play"], [aria-label*="воспроизвед" i], [aria-label*="play" i], [class*="play" i]');
            if (pauseBtn && !pauseBtn.hidden && pauseBtn.offsetParent !== null) return true;
            if (playBtn && !playBtn.hidden && playBtn.offsetParent !== null) return false;
        } catch (e) {}
        return null;
    }

    function clearLegacyFilter() {
        const canvas = getLegacyCanvas();
        if (canvas && canvas.style.filter !== 'none') {
            const dur = settings.transitionDuration || 0.6;
            canvas.style.transition = `filter ${dur}s linear`;
            void canvas.offsetHeight;
            canvas.style.filter = 'none';
            debug('Legacy filter cleared on pause');
        }
    }

    function startPauseWatcher() {
        if (pauseCheckTimer) return;
        
        // Initialize wasPlaying from actual state
        const initialState = getPlayState();
        wasPlaying = initialState === true;
        debug('Pause watcher started, initial playing:', wasPlaying);

        pauseCheckTimer = setInterval(() => {
            if (!settings.enabled || !settings.restoreOnPause) return;
            try {
                const playing = getPlayState();
                if (playing === null) return; // Can't determine state
                
                const nowPlaying = playing === true;
                
                if (wasPlaying === true && nowPlaying === false) {
                    // Just paused - restore default wave colors
                    debug('Pause detected, restoring default wave colors');
                    clearWaveColors();
                    clearLegacyFilter(); // Also clear canvas filter for legacy mode
                    dispatchWaveUpdate();
                    wasPlaying = false;
                } else if (wasPlaying === false && nowPlaying === true) {
                    // Resumed - reapply our colors
                    debug('Resume detected, reapplying colors');
                    wasPlaying = true;
                    handleTrackChange(true);
                }
            } catch (e) {
                // Ignore errors
            }
        }, 500);
    }

    function stopPauseWatcher() {
        if (pauseCheckTimer) {
            clearInterval(pauseCheckTimer);
            pauseCheckTimer = null;
        }
    }

    // ─── Canvas & wave color detection ───────────────────────────────────────
    function getLegacyRootElement() {
        return document.querySelector('.CommonLayout_root__WC_W1') ||
               document.querySelector('[class*="CommonLayout_root"]');
    }

    function getLegacyCanvas() {
        try {
            const root = document.querySelector('[class*="VibePage_root"]');
            if (root) {
                const canvas = root.querySelector('canvas');
                if (canvas) return canvas;
            }
            const anyCanvas = document.querySelector('canvas');
            if (anyCanvas) return anyCanvas;
            const animRoot = document.querySelector('[class*="VibeWidgetAnimation_root"]');
            if (animRoot) {
                const canvas = animRoot.querySelector('canvas');
                if (canvas) return canvas;
            }
        } catch (e) {
            debug('Legacy: error finding canvas', e);
        }
        debug('Legacy: canvas NOT found');
        return null;
    }

    // ─── Cover loading & cache ───────────────────────────────────────────────
    function getCoverUrl(track) {
        if (!track?.coverUri) return null;
        let u = String(track.coverUri).replace(/%%/g, '400x400');
        if (!/^https?:\/\//.test(u)) u = 'https://' + u;
        return u;
    }

    function loadColorsForTrack(track, cb) {
        const url = getCoverUrl(track);
        if (!url) { debug('No cover'); cb(null); return; }
        if (coverCache.has(url)) { debug('Cache hit'); cb(coverCache.get(url)); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        let done = false;
        const finish = (cols) => {
            if (done) return; done = true;
            if (cols?.length) {
                if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                coverCache.set(url, cols);
            }
            cb(cols?.length ? cols : null);
        };
        img.onload = () => { try { finish(extractDominantColors(img)); } catch(e){ warn('Extract err',e); finish(null); } };
        img.onerror = () => { warn('Cover load failed:',url); finish(null); };
        img.src = url;
    }

    function preloadCover(track) {
        if (!settings.preloadCovers) return;
        const url = getCoverUrl(track);
        if (!url || coverCache.has(url) || preloadQueue.has(url)) return;
        preloadQueue.add(url);
        const img = new Image();
        img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
        img.onload = () => {
            preloadQueue.delete(url);
            try {
                const cols = extractDominantColors(img);
                if (cols?.length) {
                    if (coverCache.size >= settings.maxCacheSize) coverCache.delete(coverCache.keys().next().value);
                    coverCache.set(url, cols);
                    debug('Preloaded:', url);
                }
            } catch(e) { warn('Preload extract err:', e); }
        };
        img.onerror = () => preloadQueue.delete(url);
        img.src = url;
    }

    // ─── Track processing ────────────────────────────────────────────────────
    function processTrack(track, force=false) {
        if (!settings.enabled || !track) return;
        const id = String(track.id);
        if (!force && id === currentTrackId) return;
        if (processingTrackId === id) return;
        currentTrackId = id; processingTrackId = id;
        debug(`Process: ${track.title} - ${track.artists?.[0]?.name}`);

        loadColorsForTrack(track, (colors) => {
            processingTrackId = null;
            if (String(currentTrackId) !== id) { debug('Track changed mid-load'); return; }
            if (!colors) { 
                debug('No colors extracted, trying fallback average color');
                const url = getCoverUrl(track);
                if (url) {
                    const img = new Image();
                    img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
                    img.onload = () => {
                        const fallback = getAverageColor(img);
                        if (fallback) {
                            const stops = mapColorsToStops([fallback]);
                            applyColorsByMode(stops, id);
                        }
                    };
                    img.src = url;
                }
                return; 
            }

            const stops = mapColorsToStops(colors);
            log(`Palette: ${colors.length} colors, main ${colorToCss(colors[0])}`);
            applyColorsByMode(stops, id);
        });
    }

    function getAverageColor(img) {
        const data = getImageData(img);
        if (!data) return null;
        let r=0,g=0,b=0,c=0;
        for (let i=0;i<data.length;i+=64){ r+=data[i]; g+=data[i+1]; b+=data[i+2]; c++; }
        const avgR = r/c|0, avgG = g/c|0, avgB = b/c|0;
        const hsl = rgbToHsl(avgR, avgG, avgB);
        if (hsl.l < 0.15) {
            const rgb = hslToRgb(hsl.h, hsl.s, 0.4);
            return { h: hsl.h, s: hsl.s, l: 0.4 };
        }
        return { h: hsl.h, s: hsl.s, l: hsl.l };
    }

    function applyColorsByMode(stops, trackId) {
        // Determine effective mode
        let effectiveMulti = false;
        if (settings.colorMode === 'multi') {
            effectiveMulti = true;
        } else if (settings.colorMode === 'mono') {
            effectiveMulti = false;
        } else { // 'auto'
            effectiveMulti = settings.patchInstalled === true;
        }

        const hasPatch = patchDetected;

        if (effectiveMulti && hasPatch) {
            // Multi-color mode with patch - use CSS variables (6 stops)
            setWaveColors(stops);
            applyWaveColors(trackId);
        } else if (effectiveMulti && !hasPatch) {
            // Multi-color requested but no patch - fallback to mono via legacy
            warn('Multi-color mode requires patch-vibe-colors.js. Falling back to mono (legacy).');
            applyLegacyMode(stops);
        } else {
            // Mono mode - always use legacy filters (1 color)
            applyLegacyMode(stops);
        }
    }

    function handleTrackChange(force=false) {
        if (!isReady) return;
        try {
            const track = window.pulsesyncApi?.getCurrentTrack?.();
            if (!track) return;
            if (settings.enabled) processTrack(track, force);
            else { currentTrackId = String(track.id); clearWaveColors(); }
            if (settings.preloadCovers) {
                const queue = window.pulsesyncApi?.getQueue?.();
                if (Array.isArray(queue) && queue[1]) preloadCover(queue[1]);
            }
        } catch(e) { warn('Track change err:', e); }
    }

    // ─── Settings ────────────────────────────────────────────────────────────
    function unwrap(v, fb) {
        if (v && typeof v==='object' && 'value' in v) return v.value;
        if (v && typeof v==='object' && 'default' in v) return v.default;
        return v!==undefined ? v : fb;
    }

    function applySettings(ns) {
        if (!ns || typeof ns!=='object') return;
        const prev = { ...settings };
        
        // Top-level mode switches
        settings.patchInstalled = unwrap(ns.patchInstalled, DEFAULTS.patchInstalled);
        settings.colorMode = String(unwrap(ns.colorMode, DEFAULTS.colorMode));
        settings.restoreOnPause = Boolean(unwrap(ns.restoreOnPause, DEFAULTS.restoreOnPause));
        
        // Color extraction
        settings.enabled = Boolean(unwrap(ns.enabled, DEFAULTS.enabled));
        settings.colorCount = clamp(Number(unwrap(ns.colorCount, DEFAULTS.colorCount))||DEFAULTS.colorCount, 1, 6);
        settings.colorAlgorithm = String(unwrap(ns.colorAlgorithm, DEFAULTS.colorAlgorithm));
        settings.sortBy = String(unwrap(ns.sortBy, DEFAULTS.sortBy));
        settings.saturationThreshold = Number(unwrap(ns.saturationThreshold, DEFAULTS.saturationThreshold));
        settings.lightnessMin = Number(unwrap(ns.lightnessMin, DEFAULTS.lightnessMin));
        settings.lightnessMax = Number(unwrap(ns.lightnessMax, DEFAULTS.lightnessMax));
        settings.quantizationLevel = clamp(Number(unwrap(ns.quantizationLevel, DEFAULTS.quantizationLevel))||DEFAULTS.quantizationLevel, 4, 16);
        settings.clusterThreshold = Number(unwrap(ns.clusterThreshold, DEFAULTS.clusterThreshold));
        settings.hueRotation = Number(unwrap(ns.hueRotation, DEFAULTS.hueRotation));
        settings.saturationBoost = Number(unwrap(ns.saturationBoost, DEFAULTS.saturationBoost));
        settings.lightnessBoost = Number(unwrap(ns.lightnessBoost, DEFAULTS.lightnessBoost));
        settings.transitionDuration = Number(unwrap(ns.transitionDuration, DEFAULTS.transitionDuration));

        // Monotone (legacy, kept for backwards compat)
        settings.monotoneEnabled = Boolean(unwrap(ns.monotoneEnabled, DEFAULTS.monotoneEnabled));
        settings.monotoneMethod = String(unwrap(ns.monotoneMethod, DEFAULTS.monotoneMethod));
        settings.monotoneIntensity = Number(unwrap(ns.monotoneIntensity, DEFAULTS.monotoneIntensity));
        settings.monotoneSaturation = Number(unwrap(ns.monotoneSaturation, DEFAULTS.monotoneSaturation));
        settings.monotoneBrightness = Number(unwrap(ns.monotoneBrightness, DEFAULTS.monotoneBrightness));
        settings.monotoneAdaptiveBrightness = Boolean(unwrap(ns.monotoneAdaptiveBrightness, DEFAULTS.monotoneAdaptiveBrightness));
        settings.monotoneSpecialNeutralHandling = Boolean(unwrap(ns.monotoneSpecialNeutralHandling, DEFAULTS.monotoneSpecialNeutralHandling));
        settings.monotoneSaturationPreference = Number(unwrap(ns.monotoneSaturationPreference, DEFAULTS.monotoneSaturationPreference));
        settings.fullHueIntensity = Boolean(unwrap(ns.fullHueIntensity, DEFAULTS.fullHueIntensity));

        // Legacy / Compatibility
        settings.legacyMode = String(unwrap(ns.legacyMode, DEFAULTS.legacyMode));
        settings.preloadCovers = Boolean(unwrap(ns.preloadCovers, DEFAULTS.preloadCovers));
        settings.maxCacheSize = Number(unwrap(ns.maxCacheSize, DEFAULTS.maxCacheSize));
        settings.disableGradient = Boolean(unwrap(ns.disableGradient, DEFAULTS.disableGradient));
        settings.fullHueIntensity = Boolean(unwrap(ns.fullHueIntensity, DEFAULTS.fullHueIntensity));

        const nd = Boolean(unwrap(ns.debug, DEFAULTS.debug));
        if (nd !== DEBUG) { DEBUG = nd; debug('Debug:', DEBUG); }

        // Re-detect patch if manual override changed
        if (prev.patchInstalled !== settings.patchInstalled) {
            patchDetected = detectPatch();
            log('Patch detection updated:', patchDetected);
        }

        const extractChanged = prev.colorCount!==settings.colorCount || prev.colorAlgorithm!==settings.colorAlgorithm ||
            prev.sortBy!==settings.sortBy || prev.saturationThreshold!==settings.saturationThreshold ||
            prev.lightnessMin!==settings.lightnessMin || prev.lightnessMax!==settings.lightnessMax ||
            prev.quantizationLevel!==settings.quantizationLevel || prev.clusterThreshold!==settings.clusterThreshold ||
            prev.hueRotation!==settings.hueRotation || prev.saturationBoost!==settings.saturationBoost ||
            prev.lightnessBoost!==settings.lightnessBoost || prev.monotoneMethod!==settings.monotoneMethod ||
            prev.monotoneSaturationPreference!==settings.monotoneSaturationPreference;

        if (extractChanged) { coverCache.clear(); debug('Cache cleared'); }
        if (prev.enabled !== settings.enabled) {
            log(settings.enabled?'Enabled':'Disabled');
            if (settings.enabled) { currentTrackId=null; processingTrackId=null; handleTrackChange(true); }
            else { applyToken++; clearWaveColors(); dispatchWaveUpdate(); }
            return;
        }
        if (settings.enabled && extractChanged) handleTrackChange(true);
    }

    function loadSettings() {
        const api = window.pulsesyncApi;
        if (!api?.getSettings) { debug('No settings API'); return; }
        const keys = [ADDON_NAME, 'vibecolorizer'];
        const seen = new Set(); let applied=false;
        for (const k of keys) {
            if (seen.has(k)) continue; seen.add(k);
            try {
                const store = api.getSettings(k);
                if (!store) continue;
                const cur = store.getCurrent?.() || {};
                if (!applied && Object.keys(cur).length) { applySettings(cur); applied=true; }
                store.onChange?.((ns)=>{ if(ns&&Object.keys(ns).length) applySettings(ns); });
            } catch(e) { warn(`Settings load err (${k}):`, e); }
        }
        if (!applied) debug('No saved settings');
    }

    // ─── Init ────────────────────────────────────────────────────────────────
    let trackTimer=null;
    function startTracking() {
        if (trackTimer) return;
        trackTimer = setInterval(()=>handleTrackChange(false), 500);
        handleTrackChange(true);
        document.addEventListener('pulsesync:runtime-ready',()=>{ debug('runtime-ready'); handleTrackChange(true); });
        document.addEventListener('visibilitychange',()=>{ if(!document.hidden) handleTrackChange(false); });
    }

    function init() {
        log(`v${VERSION} loading...`);
        const tryInit = () => {
            if (!window.pulsesyncApi) return false;
            isReady = true;
            log('API ready');
            patchDetected = detectPatch();
            log('Patch detected:', patchDetected);
            if (!patchDetected) startLegacyWaveObserver();
            loadSettings();
            startTracking();
            startPauseWatcher();
            // CAPTURE BASE WAVE COLOR ONCE at startup (before any filters applied)
            setTimeout(() => {
                const baseColor = captureBaseWaveColor();
                if (baseColor) {
                    debug('Base wave color captured at startup:', baseColor);
                } else {
                    debug('Could not capture base wave color at startup, will try on first track');
                }
            }, 1000);
            // Apply gradient transparency if enabled
            if (settings.disableGradient) {
                // Delay to ensure root element exists
                setTimeout(applyGradientState, 500);
            }
            return true;
        };
        if (tryInit()) return;
        const t = setInterval(()=>{ if(tryInit()) clearInterval(t); }, 250);
        setTimeout(()=>{ if(!isReady) warn('API not ready after 10s'); }, 10000);
    }

    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();