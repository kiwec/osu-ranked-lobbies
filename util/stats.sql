-- prep
update contest set tms = tms / 1000;
update score set tms = tms / 1000;

-- Contests by month
SELECT strftime('%Y-%m', datetime(tms, 'unixepoch')) as month, COUNT(*) as nb_contests FROM contest GROUP BY strftime('%Y-%m', datetime(tms, 'unixepoch'));

-- Scores by month
SELECT strftime('%Y-%m', datetime(tms, 'unixepoch')) as month, COUNT(*) as nb_scores FROM score GROUP BY strftime('%Y-%m', datetime(tms, 'unixepoch'));

-- New users per month (only counting users with >5 games)
select strftime('%Y-%m', datetime(tms, 'unixepoch')), COUNT(*) as new_users from score as t1, user where user.games_played > 5 and t1.user_id = user.user_id and not exists(select 1 from score as t2 where t1.tms < t2.tms AND t1.user_id = t2.user_id) GROUP BY strftime('%Y-%m', datetime(tms, 'unixepoch'));
