/** Local, deliberately narrow date extraction. No leave reason goes to a provider. */
export function leaveDates(message:string,today:string):{start_date:string;end_date:string}|undefined {
  const add=(n:number)=>new Date(Date.parse(`${today}T12:00:00Z`)+n*86400000).toISOString().slice(0,10);
  const dates=[...message.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]);
  if(!dates.length) {
    const names=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const current=new Date(`${today}T12:00:00Z`).getUTCDay();
    for(const m of message.toLowerCase().matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
      let n=(names.indexOf(m[0])-current+7)%7 || 7;
      if(dates[0] && add(n)<dates[0]) n+=7;
      dates.push(add(n));
    }
    if(!dates.length && /\btomorrow\b/i.test(message)) dates.push(add(1));
  }
  if(!dates.length || dates.length>2 || /\b(next week|next month|following|last|yesterday|or)\b/i.test(message)) return undefined;
  const start=dates[0]!,end=dates[1] ?? start;
  const valid=(s:string)=>Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
  return valid(start)&&valid(end)&&start>=today&&end>=start&&Date.parse(end)-Date.parse(start)<=365*86400000?{start_date:start,end_date:end}:undefined;
}
