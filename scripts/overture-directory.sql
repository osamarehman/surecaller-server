-- Builds directory.ndjson for `node dist/cli/directory.js import` from Overture Maps places
-- (https://docs.overturemaps.org/guides/places, CDLA Permissive 2.0 / Apache 2.0 / CC0).
-- Run with DuckDB: duckdb < scripts/overture-directory.sql
-- Change the release and the country to suit. Takes a few minutes; reads only the bbox.
INSTALL httpfs; LOAD httpfs; SET s3_region = 'us-west-2';
COPY (
  SELECT phone, name, category FROM (
    SELECT unnest(phones) AS phone, names.primary AS name, basic_category AS category, confidence
    FROM read_parquet('s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*', hive_partitioning = 1)
    WHERE bbox.xmin BETWEEN 60.5 AND 78.0 AND bbox.ymin BETWEEN 23.5 AND 37.2   -- Pakistan
      AND addresses[1].country = 'PK'
      AND coalesce(operating_status, 'open') = 'open'
  )
  ORDER BY confidence DESC   -- the import keeps the first name per number
) TO 'directory.ndjson' (FORMAT json);
