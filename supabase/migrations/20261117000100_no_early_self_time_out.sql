-- Staff cannot time themselves out at the QR station before their duty ends.
--
-- A time-out scan is refused until the scheduled end of the duty the time-in belongs to. Someone
-- who really must leave early (illness, an emergency) asks the Head Nurse, who records the
-- time-out with a reason (attestation); that path is unchanged, so the early leave is still on
-- record as undertime and nobody is left with an open time-in.
--
-- Extra time after the end is unchanged too: the DTR pays at most the scheduled minutes, and time
-- beyond them counts only as overtime the Head Nurse approves.
--
-- Optional policy key `time_out_opens_before_minutes` (default 0) lets HR open the time-out a few
-- minutes before the end, for example while the incoming shift takes the endorsement.

create or replace function internal.record_station_punch(p_profile uuid, p_station uuid, p_event_key text, p_source text default 'qr') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_station public.attendance_stations;
  v_me public.profiles;
  v_last public.attendance_events;
  v_kind text;
  v_id uuid;
  v_existing public.attendance_events;
  v_duty public.shifts;
  v_policy jsonb;
begin
  select * into v_existing from public.attendance_events where event_key = p_event_key;
  if found then
    return jsonb_build_object('event_id', v_existing.id, 'kind', v_existing.kind, 'captured_at', v_existing.captured_at, 'repeat', true);
  end if;
  select * into v_station from public.attendance_stations where id = p_station and is_active;
  if not found then perform app.fail('not_found', 'This attendance station is not active'); end if;
  select * into v_me from public.profiles where id = p_profile and is_active;
  if not found or v_me.department_id is distinct from v_station.department_id then
    perform app.fail('forbidden', 'This station belongs to another unit');
  end if;
  perform pg_advisory_xact_lock(hashtext('punch:' || p_profile::text));
  select * into v_last from public.attendance_events e where e.profile_id = p_profile
    and not exists (select 1 from public.attendance_event_voids v where v.event_id = e.id)
    order by e.captured_at desc limit 1;
  if found and v_last.captured_at > now() - interval '2 minutes' then
    return jsonb_build_object('event_id', v_last.id, 'kind', v_last.kind, 'captured_at', v_last.captured_at, 'repeat', true);
  end if;
  v_kind := case when found and v_last.kind = 'in' and v_last.captured_at > now() - interval '16 hours' then 'out' else 'in' end;

  if v_kind = 'out' then
    -- The duty this time-in belongs to: an assigned, scheduled duty whose matching window holds it.
    v_policy := app.policy_for((v_last.captured_at at time zone 'UTC')::date);
    select s.* into v_duty
    from public.shifts s
    join public.shift_assignments a on a.shift_id = s.id and a.employee_id = p_profile and a.removed_at is null
    where s.status = 'scheduled'
      and v_last.captured_at between s.starts_at - make_interval(mins => coalesce((v_policy ->> 'match_before_minutes')::int, 120))
                                 and s.ends_at + make_interval(mins => coalesce((v_policy ->> 'match_after_minutes')::int, 240))
    order by abs(extract(epoch from (s.starts_at - v_last.captured_at)))
    limit 1;
    if found and now() < v_duty.ends_at - make_interval(mins => coalesce((v_policy ->> 'time_out_opens_before_minutes')::int, 0)) then
      perform app.fail('too_early', format(
        'Your duty ends at %s. You can time out from then. If you must leave early, ask your Head Nurse to record your time-out.',
        trim(to_char(v_duty.ends_at at time zone v_duty.timezone, 'FMHH12:MI AM'))));
    end if;
  end if;

  insert into public.attendance_events (event_key, profile_id, department_id, kind, source, station_id, captured_at, recorded_by)
  values (p_event_key, p_profile, v_station.department_id, v_kind, p_source, p_station, now(), p_profile)
  returning id into v_id;
  update public.attendance_stations set last_seen_at = now() where id = p_station;
  perform internal.reconcile_department(v_station.department_id, (now() at time zone 'UTC')::date - 1, (now() at time zone 'UTC')::date + 1);
  return jsonb_build_object('event_id', v_id, 'kind', v_kind, 'captured_at', now(), 'repeat', false);
end $$;
