import type { PlaceCandidate } from '../shared/types'

/**
 * Google Places API (New) — Text Search. Official, keyed, pay-per-call.
 * The field mask is deliberately narrow so each search stays in the cheapest
 * SKU that still returns a name, address and website.
 */
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.primaryTypeDisplayName',
  'places.nationalPhoneNumber',
  'places.businessStatus',
].join(',')

type PlacesResponse = {
  places?: {
    id?: string
    displayName?: { text?: string }
    formattedAddress?: string
    websiteUri?: string
    primaryTypeDisplayName?: { text?: string }
    nationalPhoneNumber?: string
    businessStatus?: string
  }[]
  error?: { message?: string; status?: string }
}

export type PlacesSearch =
  | { ok: true; candidates: PlaceCandidate[] }
  | {
      ok: false
      reason: 'unavailable' | 'rejected' | 'quota' | 'error'
      message: string
    }

export async function searchBusinesses(
  apiKey: string,
  query: string,
  limit: number,
): Promise<PlacesSearch> {
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELDS,
      },
      body: JSON.stringify({
        textQuery: query,
        pageSize: limit,
        languageCode: 'en',
      }),
    })
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Could not reach the business search service. Please try again.',
    }
  }

  const body = (await response.json().catch(() => null)) as PlacesResponse | null

  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      return {
        ok: false,
        reason: 'rejected',
        message:
          'The search key was refused. Check it is a Google Places API (New) key with billing enabled and no API restrictions that block this request.',
      }
    if (response.status === 429)
      return {
        ok: false,
        reason: 'quota',
        message:
          'The search service is out of quota or rate-limited right now. Try again later.',
      }
    return {
      ok: false,
      reason: 'error',
      message:
        body?.error?.message?.slice(0, 200) ||
        'The business search service returned an error. Please try again.',
    }
  }

  const candidates: PlaceCandidate[] = (body?.places ?? [])
    .map((place) => ({
      placeId: (place.id || '').slice(0, 200),
      name: (place.displayName?.text || '').trim().slice(0, 160),
      address: (place.formattedAddress || '').trim().slice(0, 300),
      website: (place.websiteUri || '').trim().slice(0, 300),
      category: (place.primaryTypeDisplayName?.text || '').trim().slice(0, 80),
      phone: (place.nationalPhoneNumber || '').trim().slice(0, 40),
      closed: place.businessStatus === 'CLOSED_PERMANENTLY',
    }))
    .filter((candidate) => candidate.name.length > 0)

  return { ok: true, candidates }
}

/** Last comma-separated part of a formatted address, e.g. "Lagos, Nigeria" → "Nigeria". */
export function countryFromAddress(address: string): string {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1]!.slice(0, 80) : ''
}
