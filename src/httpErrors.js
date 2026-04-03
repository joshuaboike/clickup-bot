/**
 * Turn an axios error into a readable string (status + response body).
 */
function formatAxiosError(err, step = "API") {
  if (!err.response) return err.message || String(err);
  const { status, data } = err.response;
  const body =
    typeof data === "string" ? data : JSON.stringify(data, null, 0);
  return `${step} HTTP ${status}: ${body}`;
}

module.exports = { formatAxiosError };
