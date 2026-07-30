I want to create an app that allows me to pick a stock ticker from the S&P 500 and it tells me if this stock, based on its option chain, has a potential for profit by selling a calendar spread. The logic should rely on calculating the forward volatility in the period from the expiration of the shorter option to the expiration of the longer option, then comparing that to the current implied volatility, and if the ratio of IV/FV is bigger than 1, signal that a trade on that option combination is viable.

The calculation is as follows:

Forward_variance = ((variance_long * time_to_expiration_in_years_long) - (variance_short * time_to_expiration_in_years_short))/(time_to_expiration_in_years_long - time_to_expiration_in_years_short)

Forward_volatility(Tshort, Tlong) = sqrt(Forward_variance)

Forward_volatility_factor = implied_volatility_short_call/forward_volatility(Tshort, Tlong) - 1

At first, the following functionalities should be implemented incrementaly:

- Ticker selection from the app UI (the list is populated for the user)
- Table display with the calculated value (call it "Forward Volatility Factor" or something like that - prefer a name that already exists in the literature) for multiple call combinations (for example: short 30dte, long 60dte; short 60dte, long 90dte)
- The amount of DTE can be approximated in case the existing options do not align perfectly with the 30 days requirement (example: short 28dte, long 36dte)

Create a plan for the implementation of this app, with architecture, necessary formulas, APIs to be called ETC so that the next agent can implement it
