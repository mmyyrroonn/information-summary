import axios from 'axios';
import { config } from '../config';
import { RapidApiTimelineResponse } from '../types/twitter';

const twitterClient = axios.create({
  baseURL: `https://${config.RAPIDAPI_HOST}`,
  headers: {
    'x-rapidapi-host': config.RAPIDAPI_HOST,
    'x-rapidapi-key': config.RAPIDAPI_KEY ?? ''
  }
});

export async function fetchTimeline(screenName: string): Promise<RapidApiTimelineResponse> {
  if (!config.RAPIDAPI_KEY) {
    throw new Error('Missing RAPIDAPI_KEY env, cannot fetch timeline');
  }

  const response = await twitterClient.get<RapidApiTimelineResponse>(`/timeline.php`, {
    params: { screenname: screenName }
  });

  return response.data;
}
