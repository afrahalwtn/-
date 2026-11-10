-- Atomic stock-deducting execution-list commit for the Afrah Supabase backend.
-- This is additive: it never modifies existing product quantities until explicitly called.
-- The application authenticates staff first; only the server's service_role can execute it.
CREATE OR REPLACE FUNCTION public.afrah_commit_stock_dispatch(
  p_actor_id integer,
  p_receipt_id integer,
  p_request_id uuid,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_receipt jsonb;
  v_existing jsonb;
  v_digest text;
  v_count integer;
  v_prev_id integer := 0;
  v_id integer;
  v_qty integer;
  v_available integer;
  v_product jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_list_id integer;
  v_counter jsonb;
  v_counter_id integer := 104;
  v_highest integer;
  v_created_at timestamptz := clock_timestamp();
  v_entry record;
  v_record jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_actor_id < 1 OR p_receipt_id IS NULL
     OR p_receipt_id < 1000000000 OR p_receipt_id >= 2000000000
     OR p_request_id IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_STOCK_REQUEST' USING ERRCODE='P0001';
  END IF;
  v_count := jsonb_array_length(p_items);
  IF v_count < 1 OR v_count > 500 THEN
    RAISE EXCEPTION 'INVALID_STOCK_REQUEST' USING ERRCODE='P0001';
  END IF;
  v_digest := md5(p_items::text);
  INSERT INTO public.app_records(kind,id,payload)
  VALUES ('metadata',p_receipt_id,jsonb_build_object(
    'type','stock_deduction','actor_id',p_actor_id,'request_id',p_request_id::text,'digest',v_digest))
  ON CONFLICT(kind,id) DO NOTHING;
  SELECT payload INTO v_receipt FROM public.app_records
    WHERE kind='metadata' AND id=p_receipt_id FOR UPDATE;
  IF v_receipt IS NULL OR v_receipt->>'type'<>'stock_deduction' OR
     (v_receipt->>'actor_id')::integer<>p_actor_id OR
     v_receipt->>'request_id'<>p_request_id::text OR
     v_receipt->>'digest'<>v_digest THEN
    RAISE EXCEPTION 'STOCK_REQUEST_CONFLICT' USING ERRCODE='P0001';
  END IF;
  IF v_receipt ? 'list_id' THEN
    SELECT payload INTO v_existing FROM public.app_records
      WHERE kind='execution_lists' AND id=(v_receipt->>'list_id')::integer;
    IF v_existing IS NULL OR v_existing->>'client_request_id'<>p_request_id::text THEN
      RAISE EXCEPTION 'STOCK_RECEIPT_MISSING' USING ERRCODE='P0001';
    END IF;
    RETURN v_existing;
  END IF;

  -- Lock every material in ascending order, so concurrent dispatches cannot
  -- double-subtract and a shortage aborts the entire PostgreSQL transaction.
  FOR v_entry IN
    SELECT value AS item FROM jsonb_array_elements(p_items) AS t(value)
    ORDER BY CASE WHEN value->>'product_id' ~ '^[0-9]{1,9}$'
      THEN (value->>'product_id')::integer ELSE 2147483647 END
  LOOP
    IF jsonb_typeof(v_entry.item)<>'object'
      OR COALESCE(v_entry.item->>'product_id','') !~ '^[1-9][0-9]{0,8}$'
      OR COALESCE(v_entry.item->>'quantity','') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'INVALID_STOCK_REQUEST' USING ERRCODE='P0001';
    END IF;
    v_id := (v_entry.item->>'product_id')::integer;
    v_qty := (v_entry.item->>'quantity')::integer;
    IF v_qty>100000000 OR v_id<=v_prev_id THEN
      RAISE EXCEPTION 'INVALID_OR_DUPLICATE_STOCK_LINE' USING ERRCODE='P0001';
    END IF;
    v_prev_id := v_id;
    SELECT payload INTO v_product FROM public.app_records
      WHERE kind='products' AND id=v_id FOR UPDATE;
    IF v_product IS NULL OR COALESCE(v_product->>'quantity','') !~ '^[0-9]{1,9}$' THEN
      RAISE EXCEPTION 'STOCK_ITEM_MISSING:%',v_id USING ERRCODE='P0001';
    END IF;
    v_available := (v_product->>'quantity')::integer;
    IF v_available < v_qty THEN
      RAISE EXCEPTION 'STOCK_INSUFFICIENT:%:%',v_id,v_available USING ERRCODE='P0001';
    END IF;
    UPDATE public.app_records SET
      payload=jsonb_set(
        jsonb_set(payload,'{quantity}',to_jsonb(v_available-v_qty)),
        '{updated_at}',to_jsonb(to_char(v_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
    WHERE kind='products' AND id=v_id;
  END LOOP;

  -- Build the historical, immutable list in the original user-selected order.
  FOR v_entry IN SELECT value AS item FROM jsonb_array_elements(p_items) AS t(value) LOOP
    v_id := (v_entry.item->>'product_id')::integer;
    v_qty := (v_entry.item->>'quantity')::integer;
    SELECT payload INTO v_product FROM public.app_records WHERE kind='products' AND id=v_id;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id',v_id,'name',v_product->>'name',
      'description',coalesce(v_product->>'description',''),
      'manufacture',coalesce(v_product->>'manufacture',''),
      'image_url',CASE WHEN nullif(v_product->>'image_name','') IS NOT NULL
        THEN '/api/images/' || (v_product->>'image_name') ELSE NULL END,
      'quantity',v_qty));
  END LOOP;
  INSERT INTO public.app_records(kind,id,payload)
  VALUES ('metadata',v_counter_id,'{"last_id":0}'::jsonb)
  ON CONFLICT(kind,id) DO NOTHING;
  SELECT payload INTO v_counter FROM public.app_records
    WHERE kind='metadata' AND id=v_counter_id FOR UPDATE;
  SELECT COALESCE(MAX(id),0) INTO v_highest FROM public.app_records WHERE kind='execution_lists';
  v_list_id := greatest(COALESCE((v_counter->>'last_id')::integer,0),v_highest)+1;
  IF v_list_id >= 2147483647 THEN
    RAISE EXCEPTION 'STOCK_LIST_ID_EXHAUSTED' USING ERRCODE='P0001';
  END IF;
  UPDATE public.app_records SET payload=jsonb_build_object('last_id',v_list_id),
    updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
    WHERE kind='metadata' AND id=v_counter_id;
  v_record := jsonb_build_object(
    'id',v_list_id,'created_by_id',p_actor_id,
    'created_at',to_char(v_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'items',v_lines,'client_request_id',p_request_id::text,'stock_deducted',true);
  INSERT INTO public.app_records(kind,id,payload)
    VALUES ('execution_lists',v_list_id,v_record);
  UPDATE public.app_records SET
    payload=payload || jsonb_build_object('list_id',v_list_id),
    updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
    WHERE kind='metadata' AND id=p_receipt_id;
  RETURN v_record;
END;
$$;
REVOKE ALL ON FUNCTION public.afrah_commit_stock_dispatch(integer,integer,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.afrah_commit_stock_dispatch(integer,integer,uuid,jsonb)
  TO service_role;
