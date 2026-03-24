# Explainer
This skill creates a new user and a new account at once, and assigns the user to the account. 

# Inputs
firstname: text
email: text

# Initial Output
Returns 200 when API is called and there are no structural problems with the API request.

# Process
1. Checks if the email is already associated with a user. 
2. Creates a new account
3. Creates a new user with the provided firstname and email, and sets the account in the database as the accounts FK.

# Outputs
If user email already exists return: "user_exists"
If user email isn't in correct format, return "email_format_incorrect"
If all information is correct and new user is created successfully, returns firstname, email, user_id and account_id