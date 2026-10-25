import { sanitizePollText } from './role-utils.js';

export function normalizeSuggestionText(value, maxLength = 1500) {
  return sanitizePollText(String(value ?? '').trim(), maxLength).trim();
}
export function isSuggestionVote(value) {
  return value === 'up' || value === 'down';
}
export function canReviewSuggestion(currentStatus, nextStatus) {
  return currentStatus === 'pending' && (nextStatus === 'approved' || nextStatus === 'rejected');
}
