// Example documents that deliberately share terms (search, opensearch, data,
// lucene…) so the same term turns up across multiple shards at search time.
// Four docs ensure all three shards get populated.
export const PRESETS = [
  {
    name: 'OpenSearch intro',
    title: 'What is OpenSearch',
    body: 'OpenSearch is a distributed search and analytics engine for your data.',
  },
  {
    name: 'Lucene segments',
    title: 'Search with Lucene',
    body: 'Lucene stores searchable data in immutable segments built from an inverted index.',
  },
  {
    name: 'Logs use case',
    title: 'Analytics on logs',
    body: 'Teams search and analyze log data in OpenSearch to find errors fast.',
  },
  {
    name: 'Cluster basics',
    title: 'OpenSearch cluster',
    body: 'A cluster of nodes holds shards and replicas to scale search and store data.',
  },
]

export const EXAMPLE_QUERIES = ['search', 'data', 'opensearch lucene']
